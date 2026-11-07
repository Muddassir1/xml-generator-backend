import csv
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict


USERS_PATH = Path(__file__).resolve().parent / "users.json"
DB_PATH = Path(__file__).resolve().parent / "db.json"


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Dict[str, Any]):
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def normalize_name(name: str) -> str:
    return "" if name is None else " ".join(name.strip().split()).lower()


def find_user_by_name(users: list, name: str):
    n = normalize_name(name)
    for u in users:
        if normalize_name(u.get("name", "")) == n:
            return u
    return None


def get_next_user_id(users: list):
    # Find max integer id and add 1
    max_id = 0
    for u in users:
        try:
            if isinstance(u.get("id"), int):
                max_id = max(max_id, u["id"])
            else:
                # if id is numeric string, try parse
                try:
                    v = int(u.get("id"))
                    max_id = max(max_id, v)
                except Exception:
                    pass
        except Exception:
            pass
    return max_id + 1


def find_exporter(exporters: list, name: str, uid: Any):
    n = normalize_name(name)
    for e in exporters:
        if normalize_name(e.get("name", "")) == n and str(e.get("uid")) == str(uid):
            return e
    return None


def process(csv_path: Path, dry_run: bool = True):
    users_data = load_json(USERS_PATH)
    db_data = load_json(DB_PATH)

    users = users_data.setdefault("users", [])
    exporters = db_data.setdefault("exporters", [])

    added_users = 0
    updated_users = 0
    added_exporters = 0
    updated_exporters = 0

    # Build fast lookup by normalized name
    # (we still use linear searches to preserve original matching semantics; dataset likely moderate)

    with csv_path.open("r", encoding="utf-8-sig") as csvfile:
        reader = csv.DictReader(csvfile)
        required_columns = [c.lower() for c in reader.fieldnames or []]
        # Accept common header variants
        # We'll try to find appropriate header names
        # Map canonical names
        col_map = {}
        for h in reader.fieldnames or []:
            low = h.strip().lower()
            if "importer" == low:
                col_map["importer"] = h
            if "importer_tin" == low :
                col_map["importer_tin"] = h
            if "exporter" == low:
                col_map["exporter"] = h
            if "exporter_tin" == low:
                col_map["exporter_tin"] = h
        # Fallback to first/second columns if not present
        if "importer" not in col_map:
            # try first column
            col_map["importer"] = reader.fieldnames[0]
        if "importer_tin" not in col_map and len(reader.fieldnames) > 1:
            col_map["importer_tin"] = reader.fieldnames[1]
        if "exporter" not in col_map and len(reader.fieldnames) > 2:
            col_map["exporter"] = reader.fieldnames[2]
        if "exporter_tin" not in col_map and len(reader.fieldnames) > 3:
            col_map["exporter_tin"] = reader.fieldnames[3]

        for row in reader:
            importer_name = (row.get(col_map.get("importer"), "") or "").strip()
            importer_tin = (row.get(col_map.get("importer_tin"), "") or "").strip()
            exporter_name = (row.get(col_map.get("exporter"), "") or "").strip()
            exporter_tin = (row.get(col_map.get("exporter_tin"), "") or "").strip()

            if not importer_name:
                # skip blank rows
                continue

            user = find_user_by_name(users, importer_name)
            if user:
                # Update tin if not present and provided
                if importer_tin and not user.get("tin"):
                    print(f"Setting tin for existing user '{user['name']}' (id={user['id']}) to {importer_tin}")
                    if not dry_run:
                        user["tin"] = importer_tin
                    updated_users += 1
            else:
                # create user with next numeric id
                new_id = get_next_user_id(users)
                new_user = {"id": new_id, "name": importer_name}
                if importer_tin:
                    new_user["tin"] = importer_tin
                print(f"Adding user '{importer_name}' with id={new_id} tin={importer_tin}")
                if not dry_run:
                    users.append(new_user)
                added_users += 1
                user = new_user

            uid = user["id"]

            # Now handle exporter for this importer uid
            if not exporter_name:
                continue

            exporter = find_exporter(exporters, exporter_name, uid)
            if exporter:
                if exporter_tin and not exporter.get("tin"):
                    print(f"Setting tin for existing exporter '{exporter['name']}' (id={exporter['id']}) uid={uid} to {exporter_tin}")
                    if not dry_run:
                        exporter["tin"] = exporter_tin
                    updated_exporters += 1
                else:
                    # nothing to change
                    pass
            else:
                new_exporter = {
                    "id": str(uuid.uuid4()),
                    "name": exporter_name,
                    "tin": exporter_tin or "",
                    "address": "",
                    "city": "",
                    "state": "",
                    "postalcode": "",
                    "country": "",
                    "phone": "",
                    "uid": uid,
                }
                print(f"Adding exporter '{exporter_name}' for uid={uid} id={new_exporter['id']} tin={exporter_tin}")
                if not dry_run:
                    exporters.append(new_exporter)
                added_exporters += 1

    # Summary and save
    print("\nSummary:")
    print(f"  Added users: {added_users}")
    print(f"  Updated users (tin set): {updated_users}")
    print(f"  Added exporters: {added_exporters}")
    print(f"  Updated exporters (tin set): {updated_exporters}")

    if not dry_run:
        save_json(USERS_PATH, users_data)
        save_json(DB_PATH, db_data)
        print("Changes written to files.")
    else:
        print("Dry run complete — no files modified.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Update users.json and db.json from CSV of Importer/Exporter/TINs")
    parser.add_argument("csvfile", help="Path to CSV file")
    parser.add_argument("--dry-run", action="store_true", help="Don't write changes (default: show what would change)")

    args = parser.parse_args()
    csv_path = Path(args.csvfile)
    if not csv_path.exists():
        print(f"CSV file not found: {csv_path}")
        sys.exit(1)

    process(csv_path, dry_run=args.dry_run)
