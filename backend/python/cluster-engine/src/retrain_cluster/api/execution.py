"""执行器：一个常驻的 spawn 子进程 + 有界同步准入 + 硬性超时。

为什么要独立进程：聚类算法可能把 CPU 跑满，甚至因第三方库崩溃而挂掉。放进子进程后，
主服务进程始终可控，超时/崩溃都能通过"杀死并重启子进程"恢复。

三条不变式：
  1. **串行**：同一时刻只允许一个请求（由非阻塞锁保证），超出即返回 429；
  2. **有界等待**：从开始到拿到结果共享同一个 deadline，绝不无限等待；
  3. **超时后不留残骸**：一旦超时/失联，立刻销毁子进程并重启，避免旧任务仍在后台占资源。
"""

import multiprocessing as mp
import threading
import time
from ..errors import ClusterError


def worker_main(connection, settings):
    """子进程主循环：加载服务，然后循环接收请求并回传结果。

    子进程内自行构造 ClusteringService，因此模型/知识库只在子进程里加载，
    即使加载很慢（或很占内存）也不会阻塞主服务进程。
    """
    try:
        from ..services.clustering import ClusteringService

        service = ClusteringService(settings)
        connection.send(("ready", None))  # 通知父进程"我准备好了"
        while True:
            request = connection.recv()
            if request is None:  # 约定：收到 None 表示退出
                break
            try:
                result = service.cluster(request, enforce_api_limits=True)
                connection.send(("ok", result))
            except ClusterError as exc:
                # 业务异常原样回传，保留错误码与状态码
                connection.send(("error", (exc.code, exc.message, exc.status)))
            except Exception:
                # 子进程内的未知异常：只回传通用错误，不泄漏内部堆栈细节
                connection.send(("error", ("CLUSTERING_FAILED", "Clustering execution failed", 500)))
    except (EOFError, BrokenPipeError):
        pass  # 父进程已退出，正常收场
    finally:
        connection.close()


class SyncExecutor:
    """常驻子进程的同步执行器（请求-响应模型，不做并发）。"""

    def __init__(self, settings, worker=worker_main):
        self.settings, self.worker = settings, worker
        self.lock = threading.Lock()  # 用非阻塞获取实现"串行准入"
        self.state_lock = threading.RLock()  # 保护进程/连接等状态的变更
        self.process = self.connection = None
        self._ready = False

    def start(self):
        """启动（或复用已存活的）子进程。"""
        with self.state_lock:
            if self.process is not None and self.process.is_alive():
                return
            # 强制使用 spawn：fork 会把父进程的线程/连接状态复制过去，容易出问题
            ctx = mp.get_context("spawn")
            self.connection, child = ctx.Pipe()
            self.process = ctx.Process(target=self.worker, args=(child, self.settings), daemon=True)
            self.process.start()
            child.close()  # 父进程只保留自己这一端
            self._ready = False

    def ready(self):
        """查询子进程是否已完成初始化。

        首次调用会尝试读取子进程发来的 ("ready", None) 握手消息；
        此后复用缓存结果，避免每次健康检查都做一次 IO。
        """
        with self.state_lock:
            if self.process is None or not self.process.is_alive():
                return False
            if not self._ready and self.connection.poll():
                try:
                    tag, _ = self.connection.recv()
                    self._ready = tag == "ready"
                except (EOFError, OSError):
                    return False
            return self._ready

    def interrupt(self):
        """硬取消：杀掉正在执行请求的子进程，让阻塞中的 `execute` 立刻退出。

        为什么必须是"杀进程"而不是设个标志位：聚类跑的是 numpy/sklearn 的紧循环，
        Python 层没有安全的抢占点；线程又无法被强制结束。只有进程边界能保证
        "停止任务后资源真的被释放"——这也是本模块一开始就独立进程的理由。

        这里**只杀进程、不动连接对象**：`execute` 里已有的 EOF/OSError 分支会统一
        收尾并重启子进程。两个线程同时 cleanup 同一个句柄只会制造更难查的错。

        返回是否真的杀掉了一个活着的子进程（空闲时取消即返回 False）。
        """

        with self.state_lock:
            process = self.process
            if process is None or not process.is_alive():
                return False
            process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill()  # terminate 不生效时强杀
                process.join(timeout=2)
            self._ready = False
            return True

    def close(self):
        """优雅关停：terminate -> 等待 -> 必要时 kill，然后释放全部句柄。"""
        with self.state_lock:
            if self.process is not None:
                if self.process.is_alive():
                    self.process.terminate()
                    self.process.join(timeout=2)
                    if self.process.is_alive():
                        self.process.kill()  # terminate 不生效时强杀
                        self.process.join(timeout=2)
                self.process.close()
            if self.connection is not None:
                self.connection.close()
            self.process = self.connection = None
            self._ready = False

    def execute(self, request):
        """同步执行一次聚类请求。

        非阻塞地抢锁——抢不到说明已有请求在跑，直接返回 429，不排队（排队会拖垮延迟）。
        """
        if not self.lock.acquire(blocking=False):
            raise ClusterError("SERVICE_BUSY", "A clustering request is already running", 429)
        deadline = time.monotonic() + self.settings.timeout_seconds
        try:
            self.start()
            # 等待子进程就绪；期间持续检查进程存活与总超时
            while not self.ready():
                if not self.process.is_alive():
                    raise ClusterError("WORKER_UNAVAILABLE", "Execution worker failed to start", 503)
                if time.monotonic() >= deadline:
                    raise ClusterError("CLUSTERING_TIMEOUT", "Clustering exceeded its execution deadline", 504)
                time.sleep(0.01)
            self.connection.send(request)
            # 等待结果时使用"剩余时间"而非完整超时，保证整体不超 deadline
            remaining = max(0, deadline - time.monotonic())
            if not self.connection.poll(remaining):
                raise ClusterError("CLUSTERING_TIMEOUT", "Clustering exceeded its execution deadline", 504)
            tag, payload = self.connection.recv()
            if tag == "error":
                # payload 是 (code, message, status) 三元组
                raise ClusterError(*payload)
            if tag != "ok":
                raise ClusterError("WORKER_UNAVAILABLE", "Invalid worker response", 503)
            return payload
        except ClusterError as exc:
            if exc.status in {503, 504}:
                # 超时/不可用：当前子进程状态已不可信，销毁重启（异步预热，不阻塞返回）
                self.close()
                self.start()  # 异步预热；绝不让已超时的任务继续存活
            raise
        except (EOFError, BrokenPipeError, OSError):
            # 子进程断连：同样销毁重启，并把它翻译成"服务不可用"
            self.close()
            self.start()
            raise ClusterError("WORKER_UNAVAILABLE", "Execution worker disconnected", 503) from None
        finally:
            self.lock.release()
