"""In-memory execution clocks, shared by the executor and HTTP server threads.

Only browser refresh/reconnection is supported; this never resumes a task or
persists credentials, prompts, images, or platform task IDs.
"""
from collections import OrderedDict
import copy
import threading
import time
from uuid import uuid4

_lock = threading.RLock()
_runs = OrderedDict()
_MAX_FINISHED = 256


def execution_identity(extra_pnginfo, node_id):
    workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
    if not isinstance(workflow, dict):
        workflow = {}
    node = next((n for n in workflow.get("nodes", []) if str(n.get("id")) == str(node_id)), {})
    return str(workflow.get("id") or ""), str((node.get("properties") or {}).get("benbh_runtime_key") or "")


class RunClock:
    def __init__(self, family, node_id, extra_pnginfo=None):
        self.family, self.node_id = family, str(node_id)
        self.workflow_id, self.node_key = execution_identity(extra_pnginfo, node_id)
        self.run_id = uuid4().hex
        self.started_at = time.time() * 1000
        self.started = time.monotonic()
        self.ended = None
        self.revision = 0
        self.state = "running"
        self.detail = {}
        self.key = (family, self.workflow_id, self.node_id, self.node_key)
        with _lock:
            _runs[self.key] = self
            _runs.move_to_end(self.key)
            finished = [key for key, run in _runs.items() if run.ended is not None]
            for key in finished[:-_MAX_FINISHED]:
                del _runs[key]

    def update(self, detail, state="running"):
        with _lock:
            self.detail = copy.deepcopy(detail)
            self.revision += 1
            if self.ended is None and state != "running":
                self.ended = time.monotonic()
            self.state = state
            return self.snapshot()

    def snapshot(self):
        with _lock:
            return {**copy.deepcopy(self.detail), "node_id": self.node_id, "workflow_id": self.workflow_id,
                    "node_key": self.node_key, "task_family": self.family, "timing": {
                        "run_id": self.run_id, "started_at": self.started_at,
                        "elapsed_ms": max(0, ((self.ended if self.ended is not None else time.monotonic()) - self.started) * 1000),
                        "state": self.state, "revision": self.revision}}


def runtime_snapshot(family, workflow_id, node_id, node_key):
    with _lock:
        run = _runs.get((family, workflow_id, node_id, node_key))
        return run.snapshot() if run else None
