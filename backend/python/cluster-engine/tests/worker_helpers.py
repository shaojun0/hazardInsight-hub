import time


def controlled_worker(connection, settings):
    connection.send(("ready", None))
    try:
        while True:
            request = connection.recv()
            time.sleep(request.get("delay", 0))
            if request.get("crash"):
                return
            connection.send(("ok", {"echo": request.get("value")}))
    except EOFError:
        pass
