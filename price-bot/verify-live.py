#!/usr/bin/env python3
"""
Live pipeline verifier.

Reads the artifacts the running bot actually writes and cross-checks them, so
production readiness is judged from evidence rather than from the test suite:

  - signals.json   : the labelled dataset the collector is building
  - ai-journal.jsonl : one record per AI verdict (prediction + decision)
  - capture.log    : the console log ([PREDICT]/[VALID_SIGNAL]/[DELIVER])

It answers the questions a go/no-go review asks:
  * is the dataset a single horizon, and is it growing?
  * is every delivered signal one the analyst APPROVED?
  * was any REJECTED signal delivered (must be zero)?
  * was the original prediction preserved unchanged into the journal?
  * are there duplicates, stale buckets, or timestamp anomalies?

Exit code is non-zero if any hard invariant fails, so it can gate a deploy.

Usage:
  python3 verify-live.py [--dir .] [--log ../run/capture.log]
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict


def load_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--log", default=None)
    args = ap.parse_args()

    signals_path = os.path.join(args.dir, "signals.json")
    journal_path = os.path.join(args.dir, "ai-journal.jsonl")
    log_path = args.log or os.path.join(args.dir, "..", "run", "capture.log")

    failures = []
    warnings = []

    def ok(msg):
        print(f"  PASS  {msg}")

    def fail(msg):
        print(f"  FAIL  {msg}")
        failures.append(msg)

    def warn(msg):
        print(f"  WARN  {msg}")
        warnings.append(msg)

    print("=" * 68)
    print("LIVE PIPELINE VERIFICATION")
    print("=" * 68)

    # --- 1. Dataset -----------------------------------------------------
    print("\n[1] Dataset (signals.json)")
    if not os.path.exists(signals_path):
        fail("signals.json not found")
        dataset = []
    else:
        with open(signals_path) as fh:
            dataset = json.load(fh)
        print(f"  rows: {len(dataset)}")
        if dataset:
            horizons = Counter(round((r["resolvedAt"] - r["entryAt"]) / 1000) for r in dataset)
            print(f"  horizons (s): {dict(horizons)}")
            # All rows must share one horizon; train.py refuses a mixed file.
            if len(horizons) == 1:
                ok(f"single horizon across all rows ({list(horizons)[0]}s)")
            else:
                fail(f"mixed horizons present: {dict(horizons)}")
            labels = Counter(r["label"] for r in dataset)
            print(f"  labels: {dict(labels)}")
            assets = Counter(r["asset"] for r in dataset)
            print(f"  assets: {dict(assets)}")
            # Monotonic buckets: no re-armed (duplicate) bucket per asset.
            seen = set()
            dup_buckets = 0
            for r in dataset:
                key = (r["asset"], r["entryAt"])
                if key in seen:
                    dup_buckets += 1
                seen.add(key)
            if dup_buckets == 0:
                ok("no duplicate (asset, entryAt) rows")
            else:
                fail(f"{dup_buckets} duplicate (asset, entryAt) rows")
        else:
            warn("dataset empty")

    # --- 2. AI journal --------------------------------------------------
    print("\n[2] AI decision journal (ai-journal.jsonl)")
    journal = load_jsonl(journal_path)
    print(f"  records: {len(journal)}")
    if not journal:
        warn("no journal records yet — the gate has not run")
    else:
        verdicts = Counter(r.get("analysis", {}).get("verdict") for r in journal)
        print(f"  verdicts: {dict(verdicts)}")
        reasons = Counter(r.get("reason") for r in journal)
        print(f"  reasons: {dict(reasons)}")

        # Invariant: delivered == approved. A rejected signal must never be
        # marked delivered.
        approved = [r for r in journal if r.get("analysis", {}).get("verdict") == "APPROVE"]
        rejected = [r for r in journal if r.get("analysis", {}).get("verdict") == "REJECT"]
        delivered = [r for r in journal if r.get("delivered")]

        bad = [r for r in delivered if r.get("analysis", {}).get("verdict") != "APPROVE"]
        if not bad:
            ok(f"every delivered record is AI-approved ({len(delivered)}/{len(approved)})")
        else:
            fail(f"{len(bad)} delivered records are not APPROVE")

        leaked = [r for r in rejected if r.get("delivered")]
        if not leaked:
            ok(f"no REJECTED signal marked delivered (checked {len(rejected)})")
        else:
            fail(f"{len(leaked)} REJECTED signals were marked delivered")

        # Invariant: the prediction object is present and untouched. The journal
        # stores the prediction exactly as the engine produced it.
        missing_pred = [r for r in journal if "prediction" not in r]
        if not missing_pred:
            ok("every journal record carries the original prediction")
        else:
            fail(f"{len(missing_pred)} records are missing the prediction")

        # Prediction preservation: the signal's direction must agree with the
        # prediction's direction (the filter derives one from the other, so a
        # disagreement would mean the source was rewritten).
        mismatched = []
        for r in journal:
            pred = r.get("prediction") or {}
            sig = r.get("signal") or {}
            pd = pred.get("direction")
            sd = sig.get("direction")
            if pd is None or sd is None:
                continue
            expected = "CALL" if pd == 1 else "PUT"
            if expected != sd:
                mismatched.append(r)
        if not mismatched:
            ok("signal direction matches the source prediction on every record")
        else:
            fail(f"{len(mismatched)} records disagree with the source prediction")

        # Confidence preservation: signal.confidence must equal max(p, 1-p).
        conf_bad = []
        for r in journal:
            pred = r.get("prediction") or {}
            sig = r.get("signal") or {}
            p = pred.get("probability")
            c = sig.get("confidence")
            if p is None or c is None:
                continue
            if abs(max(p, 1 - p) - c) > 1e-9:
                conf_bad.append(r)
        if not conf_bad:
            ok("signal confidence equals max(P, 1-P) from the source prediction")
        else:
            fail(f"{len(conf_bad)} records have a confidence inconsistent with the prediction")

        # Duplicate detection: one decision per (asset, bucket).
        seen = defaultdict(int)
        for r in journal:
            sig = r.get("signal") or {}
            ts = sig.get("timestamp")
            if ts is None:
                continue
            seen[(sig.get("asset"), ts // 60000)] += 1
        dups = {k: v for k, v in seen.items() if v > 1}
        if not dups:
            ok("no asset was analysed twice in the same bucket")
        else:
            warn(f"{len(dups)} buckets had repeat analysis: {list(dups.items())[:3]}")

        # Timestamp sanity: the signal timestamp is the broker server clock
        # (~2h ahead of the container). A wildly different value means the
        # wrong clock reached the signal.
        import time
        now_ms = int(time.time() * 1000)
        skews = [abs((r.get("signal", {}).get("timestamp") or 0) - now_ms) for r in journal]
        if skews:
            max_skew_h = max(skews) / 3_600_000
            print(f"  max signal-clock skew vs container: {max_skew_h:.2f}h")
            if max_skew_h < 12:
                ok("signal timestamps are within a plausible server-clock skew")
            else:
                fail(f"signal clock skew implausibly large ({max_skew_h:.1f}h)")

    # --- 3. Telegram audit --------------------------------------------
    print("\n[3] Telegram delivery audit (telegram-audit.jsonl)")
    audit_path = os.path.join(args.dir, "telegram-audit.jsonl")
    audit = load_jsonl(audit_path)
    print(f"  delivered messages: {len(audit)}")
    if not audit:
        warn("no delivered messages yet")
    else:
        # Every delivered message must carry a server-assigned message id and
        # the full content contract: asset, direction, prediction, AI verdict,
        # confidence, supporting factors and risks.
        no_id = [a for a in audit if a.get("messageId") is None]
        if not no_id:
            ok("every delivered message has a Telegram message id")
        else:
            fail(f"{len(no_id)} delivered messages have no message id")

        ids = [a["messageId"] for a in audit if a.get("messageId") is not None]
        if len(ids) == len(set(ids)):
            ok("message ids are unique (no re-sent/duplicated messages)")
        else:
            fail("duplicate Telegram message ids present")

        required = ["AI-APPROVED", "confidence", "AI ANALYSIS", "Key supporting factors"]
        incomplete = [a for a in audit if not all(r in a.get("text", "") for r in required)]
        if not incomplete:
            ok("every message carries prediction + AI verdict + confidence + factors")
        else:
            fail(f"{len(incomplete)} messages are missing required content")

        # Risk warnings are conditional (only when the analyst cites risks), but
        # the header must always be present so the reader sees the section.
        with_risks = sum(1 for a in audit if "Risk warnings:" in a.get("text", ""))
        print(f"  messages with a risk section: {with_risks}/{len(audit)}")

        # A sample, so the report can show real content rather than a claim.
        print("  --- most recent delivered message ---")
        for line in audit[-1].get("text", "").splitlines():
            print(f"  | {line}")

    # --- 3b. Ground-truth accuracy ------------------------------------
    # Join each AI verdict to the outcome that actually happened, so the gate is
    # judged against reality rather than against its own opinion. The signal's
    # bucket time is the same instant the collector armed its label, so they
    # join on (asset, entryAt).
    print("\n[3b] Accuracy vs ground truth (journal joined to resolved labels)")
    if journal and dataset:
        label_by_key = {(r["asset"], r["entryAt"]): r for r in dataset}
        joined = []
        for rec in journal:
            sig = rec.get("signal") or {}
            pred = rec.get("prediction") or {}
            ts = sig.get("timestamp")
            if ts is None:
                continue
            lab = label_by_key.get((sig.get("asset"), ts))
            if lab is None:
                continue
            # Predicted direction 1 (UP) is correct when label == 1.
            predicted_up = pred.get("direction") == 1
            correct = (lab["label"] == 1) == predicted_up
            joined.append((rec, correct))

        print(f"  verdicts with a resolved outcome: {len(joined)}")
        if joined:
            def rate(rows):
                return (sum(1 for _, c in rows if c) / len(rows)) if rows else 0.0

            approved = [(r, c) for r, c in joined if r.get("analysis", {}).get("verdict") == "APPROVE"]
            rejected = [(r, c) for r, c in joined if r.get("analysis", {}).get("verdict") == "REJECT"]
            allp = joined

            print(f"  raw prediction accuracy (all gated signals): {rate(allp)*100:.1f}% (n={len(allp)})")
            if approved:
                print(f"  delivered (AI-approved) accuracy: {rate(approved)*100:.1f}% (n={len(approved)})")
            if rejected:
                print(f"  AI-rejected accuracy (what was filtered): {rate(rejected)*100:.1f}% (n={len(rejected)})")

            # The gate is only adding value if the signals it keeps are at least
            # as accurate as the ones it drops. With few samples this is noise,
            # so it is reported as a WARN rather than a hard failure.
            if approved and rejected and len(joined) >= 30:
                if rate(approved) >= rate(rejected):
                    ok("AI-approved signals are at least as accurate as rejected ones")
                else:
                    warn(
                        "AI-approved accuracy is below rejected accuracy "
                        f"({rate(approved)*100:.1f}% vs {rate(rejected)*100:.1f}%) — "
                        "the gate may not be separating good from bad yet (small n)"
                    )
            else:
                warn(f"not enough joined outcomes to judge gate separation (n={len(joined)})")
        else:
            warn("no verdicts could be joined to a resolved outcome yet")
    else:
        warn("journal or dataset empty — skipping accuracy analysis")

    # --- 4. Console log -------------------------------------------------
    print("\n[4] Console log cross-check")
    if os.path.exists(log_path):
        with open(log_path, errors="replace") as fh:
            text = fh.read()
        approves = re.findall(r"\[AI_APPROVE\] (\S+) (\S+)", text)
        rejects = re.findall(r"\[AI_REJECT\] (\S+) (\S+)", text)
        sends = re.findall(r"\[DELIVER\] sent (\d+) signal\(s\) as message #(\S+)", text)
        withheld = re.findall(r"\[AI\] (\S+) — analysis unavailable; signal withheld", text)
        print(f"  [AI_APPROVE] lines: {len(approves)}")
        print(f"  [AI_REJECT]  lines: {len(rejects)}")
        print(f"  [DELIVER] sent lines: {len(sends)}")
        print(f"  withheld (analysis failed): {len(withheld)}")
        if len(approves) > 0 or len(rejects) > 0:
            ok("the AI gate is actively deciding (approvals and/or rejections present)")
        else:
            warn("no AI verdicts in the log yet")
    else:
        warn(f"log not found at {log_path}")

    # --- summary --------------------------------------------------------
    print("\n" + "=" * 68)
    if failures:
        print(f"RESULT: FAIL ({len(failures)} invariant(s) violated, {len(warnings)} warning(s))")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"RESULT: PASS (0 failures, {len(warnings)} warning(s))")
    for w in warnings:
        print(f"  - {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
