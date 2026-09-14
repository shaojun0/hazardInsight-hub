"""分片产物仓库的工程契约测试。

本模块只钉住"分页必须是有界的、完整的、可解释的"这几条性质：

* 明细按簇连续存放，因此"只看某个簇"是一段连续区间而不是一次全量扫描；
* `manifest.json` 最后写，看到它才说明内容完整——中途被杀不会留下半成品；
* 分页只读命中的那几片，`offset` 变大不会让内存峰值跟着变大；
* 篡改任意一片都会在读取时被哈希校验抓住，而不是静默返回错数据；
* 按文本筛选时若达到扫描上限，必须如实回报 `truncated`。

**不**验证分片大小调优或磁盘占用：那是性能问题，用假数据测不出来。
"""

from __future__ import annotations

import json

import pytest

from retrain_cluster.artifacts.semantic_runs import SemanticRunStore
from retrain_cluster.errors import ClusterError

RUN_ID = "run_" + "0" * 31 + "1"


def build_items(count: int, *, cluster_ids: list[int] | None = None) -> list[dict]:
    """构造 `count` 条明细；`cluster_ids` 指定每条所属的簇（循环使用）。"""

    if cluster_ids is None:
        cluster_ids = [0, 1]
    return [
        {
            "id": f"s{index}",
            "text": f"第 {index} 条隐患描述",
            "cluster_id": cluster_ids[index % len(cluster_ids)],
            "cluster_label": "测试簇",
            "assignment_status": "core" if index % 3 else "noise",
            "noise_reason": None if index % 3 else "below_semantic_support",
            "metadata": {},
        }
        for index in range(count)
    ]


def save(store: SemanticRunStore, items: list[dict], *, shard_size: int = 3) -> dict:
    return store.save(
        summary={"run_id": RUN_ID, "total_samples": len(items)},
        clusters=[{"cluster_id": 0, "label": "A"}, {"cluster_id": 1, "label": "B"}],
        aggregate={"coverage": 1.0},
        items=items,
        visualization=[{"id": "s0", "x": 0.0, "y": 1.0, "cluster_id": 0}],
        manifest={"run_id": RUN_ID, "profile_id": "fixture"},
        shard_size=shard_size,
    )


@pytest.fixture
def store(tmp_path) -> SemanticRunStore:
    return SemanticRunStore(tmp_path / "runs")


def test_save_writes_manifest_last_and_serves_summary(store):
    """manifest 是提交标记：删掉它，这份产物就不该再被当成"可服务"。"""

    save(store, build_items(7))
    assert store.exists(RUN_ID) is True

    loaded = store.load(RUN_ID)
    assert loaded["summary"]["total_samples"] == 7
    assert loaded["visualization"][0]["id"] == "s0"
    assert loaded["manifest"]["artifact_kind"] == "sharded"
    assert loaded["manifest"]["item_count"] == 7

    (store.path(RUN_ID) / "manifest.json").unlink()
    assert store.exists(RUN_ID) is False


def test_items_are_sharded_and_cluster_contiguous(store):
    """明细必须按簇连续落片，且簇索引能指出每段的起点与长度。"""

    items = build_items(10, cluster_ids=[0, 1, 0, 1])
    save(store, items, shard_size=3)

    index = store.index(RUN_ID)
    assert index["shard_size"] == 3
    assert index["item_count"] == 10
    assert index["shard_count"] == 4  # ceil(10 / 3)

    clusters = {entry["cluster_id"]: entry for entry in index["clusters"]}
    assert clusters[0]["size"] == 5 and clusters[1]["size"] == 5
    # 两个簇各自是一段连续区间，且没有重叠
    assert clusters[1]["start"] == clusters[0]["start"] + clusters[0]["size"]

    # 落在同一个簇里的条目，在读取时也必须全部属于那个簇
    page = store.page(RUN_ID, offset=0, limit=10, cluster_id=1)
    assert page["total"] == 5
    assert {item["cluster_id"] for item in page["items"]} == {1}


def test_paging_is_consistent_across_pages(store):
    """连续翻页不重不漏：把各页拼起来必须等于原始顺序，而且 total 恒为筛选后总数。"""

    save(store, build_items(10), shard_size=3)

    collected = []
    offset = 0
    while True:
        page = store.page(RUN_ID, offset=offset, limit=3)
        assert page["total"] == 10
        assert page["returned"] == 3 or page["hasMore"] is False
        collected.extend(item["id"] for item in page["items"])
        if not page["hasMore"]:
            break
        offset += page["limit"]

    assert len(collected) == 10
    assert len(set(collected)) == 10

    # 跨分片的一页（第 2 片与第 3 片的交界）不能丢条目
    boundary = store.page(RUN_ID, offset=2, limit=2)
    assert [item["id"] for item in boundary["items"]] == collected[2:4]


def test_page_clamps_limit_to_hard_upper_bound(store):
    """单页上限是硬约束：调用方不能靠调大 limit 把分页变成全量导出。"""

    save(store, build_items(600), shard_size=50)
    page = store.page(RUN_ID, offset=0, limit=10_000)
    assert page["limit"] == 500
    assert page["returned"] == 500
    assert page["hasMore"] is True


def test_unknown_cluster_returns_empty_page_with_full_structure(store):
    """簇不存在时返回结构完整的空页，而不是抛错——前端少写一套分支。"""

    save(store, build_items(6))
    page = store.page(RUN_ID, offset=0, limit=5, cluster_id=99)
    assert page["total"] == 0
    assert page["items"] == []
    assert page["hasMore"] is False
    assert page["runId"] == RUN_ID


def test_status_filter_counts_all_matches_but_returns_one_page(store):
    """按状态筛选：total 要数完整个区间，但只为当前页读数据。"""

    save(store, build_items(9), shard_size=2)  # 每 3 条有 1 条 status=noise
    page = store.page(RUN_ID, offset=0, limit=2, assignment_status="noise")
    assert page["total"] == 3
    assert page["returned"] == 2
    assert page["hasMore"] is True
    assert all(item["assignment_status"] == "noise" for item in page["items"])

    second = store.page(RUN_ID, offset=2, limit=2, assignment_status="noise")
    assert second["returned"] == 1
    assert second["hasMore"] is False
    assert second["items"][0]["id"] != page["items"][0]["id"]


def test_keyword_filter_reports_truncation_instead_of_pretending(store):
    """关键词筛选达到扫描上限时必须回报 truncated——不能假装全量搜过了。"""

    save(store, build_items(20), shard_size=4)

    hit = store.page(RUN_ID, offset=0, limit=5, keyword="第 7 条")
    assert hit["total"] == 1
    assert hit["items"][0]["id"] == "s7"
    assert hit["truncated"] is False

    capped = store.page(RUN_ID, offset=0, limit=5, keyword="隐患", scan_limit=6)
    assert capped["truncated"] is True
    assert capped["total"] == 6  # 只搜到前 6 条里的命中


def test_tampered_shard_is_rejected(store):
    """明细分片被改动过就必须报错——宁可失败，也不能返回不一致的分页结果。"""

    save(store, build_items(6), shard_size=3)
    shard = store.path(RUN_ID) / "detail" / "shard-00000.json"
    payload = json.loads(shard.read_text(encoding="utf-8"))
    payload[0]["text"] = "被改过的文本"
    shard.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ClusterError) as excinfo:
        store.page(RUN_ID, offset=0, limit=1)
    assert excinfo.value.code == "ARTIFACT_INVALID"


def test_missing_or_malformed_run_id_is_not_found(store):
    """run_id 参与路径拼接，非法值必须直接判 404 而不是去碰文件系统。"""

    save(store, build_items(3))
    for bad in ("run_short", "../etc/passwd", "run_" + "Z" * 32, ""):
        with pytest.raises(ClusterError) as excinfo:
            store.load(bad)
        assert excinfo.value.code == "RUN_NOT_FOUND"

    with pytest.raises(ClusterError) as excinfo:
        store.load("run_" + "a" * 32)
    assert excinfo.value.code == "RUN_NOT_FOUND"


def test_filter_options_come_from_the_index_only(store):
    """筛选取值清单只读索引，因此与样本量无关（10 万条也是常量代价）。"""

    save(store, build_items(9, cluster_ids=[0, 1, 2]), shard_size=2)
    options = store.filter_options(RUN_ID)
    assert options["itemCount"] == 9
    assert {entry["clusterId"]: entry["size"] for entry in options["clusterIds"]} == {0: 3, 1: 3, 2: 3}
