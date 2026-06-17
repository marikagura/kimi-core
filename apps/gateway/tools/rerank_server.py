#!/usr/bin/env python3
# Local cross-encoder rerank server (the reranker `local` provider).
#
# FREE (no per-call cost) + PRIVATE (text never leaves the host) + CJK-strong
# (BAAI/bge-reranker-v2-m3). The reranker `local` provider POSTs
# {query, documents} here and gets {scores} back, aligned to input order and
# sigmoid-normalized to [0,1].
#
# -- Setup (once) -----------------------------------------------------------
#   python3 -m venv .rerank-venv
#   source .rerank-venv/bin/activate
#   pip install --upgrade pip
#   pip install fastapi "uvicorn[standard]" sentence-transformers torch
#   # torch pulls the CPU wheel by default on a CPU-only box (~200MB)
#
# -- Run --------------------------------------------------------------------
#   source .rerank-venv/bin/activate
#   python3 tools/rerank_server.py            # first run downloads ~2.3GB model
#   # background: nohup python3 tools/rerank_server.py > rerank.log 2>&1 &
#
#   Lighter fallback if RAM/CPU is tight (278M, still CJK-ok):
#     RERANK_MODEL=BAAI/bge-reranker-base python3 tools/rerank_server.py
#
# -- Point the gateway/eval at it -------------------------------------------
#   RERANK_PROVIDER=local <run the eval>
#   (the local URL defaults to http://127.0.0.1:8787/rerank)
#
import os
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder
import uvicorn

MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
HOST = os.environ.get("RERANK_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
MAX_LEN = int(os.environ.get("RERANK_MAX_LEN", "512"))

print(f"[rerank] loading {MODEL} (max_length={MAX_LEN}) — first run downloads the model ...", flush=True)
model = CrossEncoder(MODEL, max_length=MAX_LEN)
print("[rerank] ready", flush=True)

app = FastAPI()


class Req(BaseModel):
    query: str
    documents: list[str]


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/rerank")
def rerank(req: Req):
    if not req.documents:
        return {"scores": []}
    pairs = [[req.query, d] for d in req.documents]
    # bge-reranker outputs a single relevance logit per pair; sigmoid -> [0,1].
    logits = model.predict(pairs, convert_to_numpy=True, show_progress_bar=False)
    probs = 1.0 / (1.0 + np.exp(-np.asarray(logits, dtype=float)))
    return {"scores": [float(x) for x in np.atleast_1d(probs)]}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
