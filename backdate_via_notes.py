"""
PIA Test Plan v1.1 — Backdate Notes Script
Posts a HubSpot engagement note to each PIA test deal dated N days ago,
simulating deal activity age for stall detection testing.

HubSpot's hs_last_modified_date is system-controlled and cannot be set via API.
However, PIA's stall detection engine reads engagement activity timestamps —
so posting a note dated N days ago is the correct way to simulate stale deals.

Usage:
    python backdate_via_notes.py --key-file C:/Users/DonMe/pia-agent/hs_key.txt

The script uses the deal IDs captured during seeding.
"""

import argparse
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

# ---------------------------------------------------------------------------
# Deal ID map — captured from seed_pia_deals.py output
# Format: deal_id: (label, days_to_backdate)
# days_to_backdate = 0 means post note as TODAY (active deals)
# ---------------------------------------------------------------------------

DEAL_NOTES = {
    "329574751987": ("ACTIVE-01 | Acme Corp — 3 days",           3),
    "329567373012": ("ACTIVE-02 | BlueSky SaaS — 1 day",          1),
    "329563717336": ("STALLED-01 | Redwood Analytics — 7 days",   7),
    "329506863854": ("STALLED-02 | Northstar Logistics — 11 days",11),
    "329369469670": ("CRITICAL-01 | Pinnacle Health — 20 days",   20),
    "329574751991": ("CRITICAL-02 | Cascade Financial — 31 days", 31),
    "329574879973": ("EDGE-01 | Vertex Software — 9 days",         9),
    "329541749495": ("EDGE-02 | Ironwood Tech — 16 days",         16),
    "329574832872": ("CLOSED-WON | Summit Retail — 20 days",      20),
    "329574840040": ("CLOSED-LOST | Harbor Brands — 25 days",     25),
}

HUBSPOT_API_BASE = "https://api.hubapi.com"


def get_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def backdate_timestamp_ms(days):
    """Return epoch milliseconds for N days ago at 9:00 AM CDT."""
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    dt = dt.replace(hour=14, minute=0, second=0, microsecond=0)  # 9AM CDT = 14:00 UTC
    return int(dt.timestamp() * 1000)


def post_note(token, deal_id, label, days):
    """
    Post a HubSpot engagement note to a deal, timestamped N days ago.
    Uses the v1 engagements API which supports custom timestamps.
    """
    timestamp_ms = backdate_timestamp_ms(days)
    backdated_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")

    url = f"{HUBSPOT_API_BASE}/engagements/v1/engagements"
    payload = {
        "engagement": {
            "active": True,
            "type": "NOTE",
            "timestamp": timestamp_ms,
        },
        "associations": {
            "dealIds": [int(deal_id)],
        },
        "metadata": {
            "body": (
                f"[PIA TEST NOTE] Simulated last activity for stall detection testing.\n"
                f"Deal: {label}\n"
                f"Intended activity date: {backdated_date} ({days} days ago)\n"
                f"This note was posted by backdate_via_notes.py to simulate deal age."
            )
        },
    }

    for attempt in range(1, 4):
        resp = requests.post(url, headers=get_headers(token), json=payload, timeout=30)

        if resp.status_code in (200, 201):
            engagement_id = resp.json().get("engagement", {}).get("id", "unknown")
            print(f"  ✅  Noted  |  {label}")
            print(f"         Backdated to: {backdated_date}  |  Engagement ID: {engagement_id}")
            return

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"  ⚠️  Rate limited. Waiting {wait}s before retry {attempt}/3…")
            time.sleep(wait)
            continue

        print(f"  ❌  FAILED  |  {label}")
        print(f"         Status: {resp.status_code}")
        print(f"         Body:   {resp.text}")
        resp.raise_for_status()

    raise RuntimeError(f"Failed to post note after 3 retries: {label}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Post backdated notes to PIA test deals to simulate activity age."
    )
    parser.add_argument(
        "--key-file",
        required=True,
        help="Path to file containing your HubSpot Private App token.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be posted without hitting HubSpot.",
    )
    args = parser.parse_args()

    # Load token
    try:
        with open(args.key_file, "r") as f:
            token = f.read().strip()
        if not token:
            raise ValueError("Key file is empty.")
    except FileNotFoundError:
        print(f"ERROR: Key file not found: {args.key_file}")
        sys.exit(1)

    print("\n══════════════════════════════════════════════════")
    print("  PIA Backdate Notes — HubSpot CRM")
    print(f"  {len(DEAL_NOTES)} deals  |  {'DRY RUN' if args.dry_run else 'LIVE'}")
    print("══════════════════════════════════════════════════\n")

    succeeded = []
    failed = []

    for deal_id, (label, days) in DEAL_NOTES.items():
        backdated_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")

        if args.dry_run:
            print(f"  DRY RUN  |  {label}")
            print(f"           |  Deal ID: {deal_id}  |  Note date: {backdated_date}\n")
            continue

        try:
            post_note(token, deal_id, label, days)
            succeeded.append(label)
        except Exception as e:
            failed.append({"label": label, "error": str(e)})

        time.sleep(0.3)

    print("\n══════════════════════════════════════════════════")
    print(f"  Done.  Succeeded: {len(succeeded)}  |  Failed: {len(failed)}")
    print("══════════════════════════════════════════════════\n")

    if failed:
        print("FAILED:")
        for f in failed:
            print(f"  {f['label']} — {f['error']}")
        sys.exit(1)

    if not args.dry_run:
        print("Next step: run PIA's stall detection engine and verify classifications:")
        print("  ACTIVE  — Acme Corp (3d), BlueSky SaaS (1d)")
        print("  STALLED — Redwood Analytics (7d), Northstar Logistics (11d), Vertex Software (9d)")
        print("  CRITICAL — Pinnacle Health (20d), Cascade Financial (31d), Ironwood Tech (16d)")
        print("  EXCLUDED — Summit Retail (Closed Won), Harbor Brands (Closed Lost)")
        print()


if __name__ == "__main__":
    main()
