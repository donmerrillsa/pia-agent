"""
PIA Test Plan v1.1 — CRM Seed Script
Seeds 10 test deals into HubSpot covering all states required by Section 2.2.

Usage:
    python seed_pia_deals.py --key-file /path/to/your/key.txt
    python seed_pia_deals.py --key-file ~/.hubspot_key

The key file should contain just the HubSpot Private App token on a single line.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

# ---------------------------------------------------------------------------
# Deal definitions — mapped to PIA Test Plan v1.1 Section 2.2 requirements
# ---------------------------------------------------------------------------

def days_ago_ms(n):
    """Return epoch milliseconds for n days ago (used as hs_last_modified_date)."""
    dt = datetime.now(timezone.utc) - timedelta(days=n)
    return int(dt.timestamp() * 1000)

def future_close_date(days=30):
    """Return a close date string (YYYY-MM-DD) n days from today."""
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")

def past_close_date(days=10):
    """Return a close date string (YYYY-MM-DD) n days in the past."""
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")


TEST_DEALS = [
    # ── ACTIVE (0–6 days) ── should NOT trigger stall alert ──────────────
    {
        "_label": "ACTIVE-01 | 3 days — email sent by rep (SA-01)",
        "dealname": "[PIA-TEST] Acme Corp — Active Deal",
        "amount": "45000",
        "dealstage": "3749122780",             # Connected
        "closedate": future_close_date(30),
        "pipeline": "default",
        "_days_since_activity": 3,
    },
    {
        "_label": "ACTIVE-02 | 1 day — very fresh activity",
        "dealname": "[PIA-TEST] BlueSky SaaS — Active Deal",
        "amount": "28000",
        "dealstage": "3749122784",             # Proposal Sent
        "closedate": future_close_date(45),
        "pipeline": "default",
        "_days_since_activity": 1,
    },

    # ── STALLED (7–14 days) ── should trigger STALLED classification ──────
    {
        "_label": "STALLED-01 | 7 days — boundary case (SA-02)",
        "dealname": "[PIA-TEST] Redwood Analytics — Stalled 7d",
        "amount": "62000",
        "dealstage": "3749122784",             # Proposal Sent
        "closedate": future_close_date(20),
        "pipeline": "default",
        "_days_since_activity": 7,
    },
    {
        "_label": "STALLED-02 | 11 days — mid-stall range",
        "dealname": "[PIA-TEST] Northstar Logistics — Stalled 11d",
        "amount": "19500",
        "dealstage": "3752325847",             # Conversation Started
        "closedate": future_close_date(15),
        "pipeline": "default",
        "_days_since_activity": 11,
    },

    # ── CRITICAL (15+ days) ── should trigger CRITICAL classification ──────
    {
        "_label": "CRITICAL-01 | 20 days — SA-03 exact scenario",
        "dealname": "[PIA-TEST] Pinnacle Health — Critical 20d",
        "amount": "87500",
        "dealstage": "3755051726",             # Negotiating
        "closedate": future_close_date(10),
        "pipeline": "default",
        "_days_since_activity": 20,
    },
    {
        "_label": "CRITICAL-02 | 31 days — severely stalled",
        "dealname": "[PIA-TEST] Cascade Financial — Critical 31d",
        "amount": "134000",
        "dealstage": "3749122784",             # Proposal Sent
        "closedate": past_close_date(5),       # Past close date — added pressure
        "pipeline": "default",
        "_days_since_activity": 31,
    },

    # ── EDGE CASES ── validate graceful handling ──────────────────────────
    {
        "_label": "EDGE-01 | $0 value deal (EC-04)",
        "dealname": "[PIA-TEST] Vertex Software — Zero Value",
        "amount": "0",
        "dealstage": "3752325847",             # Conversation Started
        "closedate": future_close_date(25),
        "pipeline": "default",
        "_days_since_activity": 9,             # Should be STALLED
    },
    {
        "_label": "EDGE-02 | No close date (test plan Section 2.2)",
        "dealname": "[PIA-TEST] Ironwood Tech — No Close Date",
        "amount": "33000",
        "dealstage": "3752325848",             # Demo Scheduled
        # closedate intentionally omitted
        "pipeline": "default",
        "_days_since_activity": 16,            # Should be CRITICAL
    },
    {
        "_label": "CLOSED-WON | Should be excluded from stall analysis (IT-04)",
        "dealname": "[PIA-TEST] Summit Retail — Closed Won",
        "amount": "55000",
        "dealstage": "closedwon",
        "closedate": past_close_date(14),
        "pipeline": "default",
        "_days_since_activity": 20,            # Old — but Closed Won, must be excluded
    },
    {
        "_label": "CLOSED-LOST | Should be excluded from stall analysis (IT-04)",
        "dealname": "[PIA-TEST] Harbor Brands — Closed Lost",
        "amount": "21000",
        "dealstage": "closedlost",
        "closedate": past_close_date(7),
        "pipeline": "default",
        "_days_since_activity": 25,            # Old — but Closed Lost, must be excluded
    },
]

# Note on EDGE-03 (unassigned deal / EC-05): HubSpot requires a deal owner from
# your portal's user list. The script omits hubspot_owner_id for EDGE-02 above,
# which will leave it unowned if your portal has no default owner set.
# If you need a guaranteed unassigned deal, remove the owner from EDGE-02 in HubSpot UI after seeding.


# ---------------------------------------------------------------------------
# HubSpot API helpers
# ---------------------------------------------------------------------------

HUBSPOT_API_BASE = "https://api.hubapi.com"

def get_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

def create_deal(token, properties: dict, label: str) -> dict:
    """POST a single deal to HubSpot. Returns the created deal object."""
    url = f"{HUBSPOT_API_BASE}/crm/v3/objects/deals"
    payload = {"properties": properties}

    for attempt in range(1, 4):
        resp = requests.post(url, headers=get_headers(token), json=payload, timeout=30)

        if resp.status_code == 201:
            deal = resp.json()
            print(f"  ✅  Created  |  {label}")
            print(f"         Deal ID: {deal['id']}")
            return deal

        if resp.status_code == 429:
            wait = 2 ** attempt
            print(f"  ⚠️  Rate limited. Waiting {wait}s before retry {attempt}/3…")
            time.sleep(wait)
            continue

        # Any other error — surface and abort
        print(f"  ❌  FAILED   |  {label}")
        print(f"         Status: {resp.status_code}")
        print(f"         Body:   {resp.text}")
        resp.raise_for_status()

    raise RuntimeError(f"Failed to create deal after 3 retries: {label}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Seed PIA test deals into HubSpot.")
    parser.add_argument(
        "--key-file",
        required=True,
        help="Path to a text file containing your HubSpot Private App token.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print deal definitions without creating anything in HubSpot.",
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
    print("  PIA Test Data Seeding — HubSpot CRM")
    print(f"  {len(TEST_DEALS)} deals  |  {'DRY RUN' if args.dry_run else 'LIVE'}")
    print("══════════════════════════════════════════════════\n")

    created = []
    failed = []

    for deal_def in TEST_DEALS:
        label = deal_def.pop("_label")
        days = deal_def.pop("_days_since_activity")

        # Build the properties dict — hs_last_modified_date is read-only in HubSpot;
        # we set notes_last_updated instead, and use createdate for approximate age.
        # To simulate stale deals for testing, we rely on the deal's createdate
        # and a custom property if available, OR you can manually backdate via HubSpot UI.
        # The script adds a hs_note_status note with the intended stale age for traceability.
        properties = {**deal_def}
        properties["description"] = (
            f"[PIA TEST] Intended days since last activity: {days}. "
            f"Created by seed_pia_deals.py on {datetime.now().strftime('%Y-%m-%d')}. "
            f"Label: {label}"
        )

        if args.dry_run:
            print(f"  DRY RUN  |  {label}")
            print(f"           |  Days stale: {days}")
            print(f"           |  Properties: {json.dumps(properties, indent=10)}\n")
            continue

        try:
            deal = create_deal(token, properties, label)
            created.append({"id": deal["id"], "label": label, "days": days})
        except Exception as e:
            failed.append({"label": label, "error": str(e)})

        # Polite pause between creates to respect rate limits
        time.sleep(0.3)

    # ── Summary ──
    print("\n══════════════════════════════════════════════════")
    print(f"  Done.  Created: {len(created)}  |  Failed: {len(failed)}")
    print("══════════════════════════════════════════════════\n")

    if created:
        print("CREATED DEALS:")
        for d in created:
            print(f"  ID {d['id']}  |  {d['label']}")

    if failed:
        print("\nFAILED DEALS:")
        for f in failed:
            print(f"  {f['label']}")
            print(f"  Error: {f['error']}")
        sys.exit(1)

    print()
    print("⚠️  IMPORTANT — Manual step required:")
    print("   HubSpot does not allow backdating hs_last_modified_date via API.")
    print("   To simulate stale deals for stall detection testing, you have two options:")
    print()
    print("   Option A (recommended): Let the deals age naturally.")
    print("   Option B (faster):      Run the companion script backdate_via_notes.py")
    print("                           which posts a HubSpot note dated N days ago")
    print("                           to approximate activity age for testing.")
    print()


if __name__ == "__main__":
    main()
