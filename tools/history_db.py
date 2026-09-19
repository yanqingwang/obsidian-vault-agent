#!/usr/bin/env python3
"""Import Vault Agent's ``history.jsonl`` transcript into SQLite for search.

The Vault Agent Obsidian plugin appends one JSON object per chat event to
``<vault>/.obsidian/plugins/vault-agent/history.jsonl`` (see ``history.ts``).
The plugin's own ``data.json`` only keeps the last 40 messages; this file is the
durable trail. Import it to query conversations by keyword, session or tool.

Usage
-----
    python tools/history_db.py import                 # default command
    python tools/history_db.py --vault ~/wk/wk import  # pick the vault explicitly
    python tools/history_db.py search 同步任务
    python tools/history_db.py search 笔记 --type user --limit 20
    python tools/history_db.py search --tool read_note
    python tools/history_db.py sessions
    python tools/history_db.py show 8f3a          # session-id prefix
    python tools/history_db.py stats

Import is idempotent: events carry a random ``id`` which is UNIQUE in the
``messages`` table, so re-running only inserts what is new. The database lands
next to the JSONL (``history.db``) unless ``--db`` says otherwise.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

PLUGIN_ID = "vault-agent"
JSONL_NAME = "history.jsonl"
DB_NAME = "history.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL UNIQUE,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL DEFAULT 0,
    turn        INTEGER,
    ts_ms       INTEGER,
    iso         TEXT,
    type        TEXT,
    role        TEXT,
    content     TEXT,
    reasoning   TEXT,
    tool        TEXT,
    call_id     TEXT,
    args        TEXT,
    ok          INTEGER,
    duration_ms INTEGER,
    model       TEXT,
    provider    TEXT,
    vault       TEXT,
    raw         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages(ts_ms);
CREATE INDEX IF NOT EXISTS idx_messages_type    ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_tool    ON messages(tool);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    vault      TEXT,
    provider   TEXT,
    model      TEXT,
    started_ms INTEGER,
    last_ms    INTEGER,
    started_at TEXT,
    last_at    TEXT,
    events     INTEGER NOT NULL DEFAULT 0,
    first_user TEXT
);
"""


def discover_jsonl(explicit: str | None, vault: str | None) -> Path:
    """Resolve the transcript path from --jsonl / --vault / auto-discovery."""
    if explicit:
        return Path(explicit).expanduser()
    if vault:
        return Path(vault).expanduser() / ".obsidian" / "plugins" / PLUGIN_ID / JSONL_NAME

    candidates: list[Path] = []
    here = Path.cwd().resolve()
    candidates.extend(parent / ".obsidian" / "plugins" / PLUGIN_ID / JSONL_NAME for parent in (here, *here.parents))
    candidates.append(Path.home() / "wk" / "wk" / ".obsidian" / "plugins" / PLUGIN_ID / JSONL_NAME)
    candidates.append(Path.home() / "wk" / ".obsidian" / "plugins" / PLUGIN_ID / JSONL_NAME)

    for cand in candidates:
        if cand.exists():
            return cand
    return candidates[0]


def connect(db_path: Path, *, create: bool) -> sqlite3.Connection:
    if not create and not db_path.exists():
        sys.exit(f"no database at {db_path} — run an import first")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def ensure_fts(conn: sqlite3.Connection) -> bool:
    """Create the full-text index. ``trigram`` handles CJK substring search."""
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5("
            "content, reasoning, content='messages', content_rowid='id', tokenize='trigram')"
        )
        return True
    except sqlite3.OperationalError:
        return False


def parse_events(jsonl_path: Path) -> tuple[list[dict], int]:
    """Read every JSONL line; return the parsed events and the skipped-line count."""
    events: list[dict] = []
    skipped = 0
    with jsonl_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                # A crash mid-append can leave a torn last line; the next run
                # usually writes it out again. Skip rather than abort the import.
                skipped += 1
                continue
            if isinstance(obj, dict) and obj.get("id"):
                events.append(obj)
            else:
                skipped += 1
    return events, skipped


def rebuild_sessions(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM sessions")
    conn.execute(
        """
        INSERT INTO sessions (id, vault, provider, model, started_ms, last_ms, events)
        SELECT m.session_id, MAX(m.vault), MAX(m.provider), MAX(m.model),
               MIN(m.ts_ms), MAX(m.ts_ms), COUNT(*)
        FROM messages m
        GROUP BY m.session_id
        """
    )
    conn.execute(
        """
        UPDATE sessions SET
            started_at = strftime('%Y-%m-%d %H:%M:%S', started_ms / 1000.0, 'unixepoch', 'localtime'),
            last_at    = strftime('%Y-%m-%d %H:%M:%S', last_ms    / 1000.0, 'unixepoch', 'localtime'),
            first_user = COALESCE((
                SELECT content FROM messages m
                WHERE m.session_id = sessions.id AND m.type = 'user'
                ORDER BY m.seq LIMIT 1
            ), '')
        """
    )


def cmd_import(conn: sqlite3.Connection, jsonl_path: Path, *, fts: bool) -> None:
    events, skipped = parse_events(jsonl_path)
    before = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    conn.executemany(
        """
        INSERT OR IGNORE INTO messages
            (event_id, session_id, seq, turn, ts_ms, iso, type, role, content, reasoning,
             tool, call_id, args, ok, duration_ms, model, provider, vault, raw)
        VALUES
            (:id, :session, :seq, :turn, :ts, :iso, :type, :role, :content, :reasoning,
             :tool, :callId, :args, :ok, :durationMs, :model, :provider, :vault, :raw)
        """,
        [
            {
                "id": e["id"],
                "session": e.get("session") or "unknown",
                "seq": e.get("seq") or 0,
                "turn": e.get("turn"),
                "ts": e.get("ts"),
                "iso": e.get("iso"),
                "type": e.get("type"),
                "role": e.get("role"),
                "content": e.get("content"),
                "reasoning": e.get("reasoning"),
                "tool": e.get("tool"),
                "callId": e.get("callId"),
                "args": e.get("args"),
                "ok": None if e.get("ok") is None else int(bool(e["ok"])),
                "durationMs": e.get("durationMs"),
                "model": e.get("model"),
                "provider": e.get("provider"),
                "vault": e.get("vault"),
                "raw": json.dumps(e, ensure_ascii=False),
            }
            for e in events
        ],
    )
    rebuild_sessions(conn)
    if fts:
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    added = total - before
    print(f"imported {added} new event(s) from {jsonl_path}")
    print(f"database: {conn.execute('PRAGMA database_list').fetchone()['file']}")
    print(f"totals:   {total} events across {sessions} session(s)")
    if skipped:
        print(f"skipped:  {skipped} unparsable line(s)")
    if not fts:
        print("note:     FTS5 unavailable — search falls back to LIKE")


def cmd_search(conn: sqlite3.Connection, query: str | None, *, fts: bool, limit: int,
               session: str | None, etype: str | None, tool: str | None) -> None:
    where: list[str] = []
    params: list[object] = []
    if etype:
        where.append("m.type = ?")
        params.append(etype)
    if tool:
        where.append("m.tool = ?")
        params.append(tool)
    if session:
        where.append("m.session_id LIKE ?")
        params.append(session + "%")

    if query:
        if fts and len(query) >= 3:
            where.append("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
            params.append('"' + query.replace('"', '""') + '"')
        else:
            where.append("(m.content LIKE ? OR m.reasoning LIKE ?)")
            params.extend([f"%{query}%", f"%{query}%"])

    sql = (
        "SELECT m.* FROM messages m"
        + (" WHERE " + " AND ".join(where) if where else "")
        + " ORDER BY m.ts_ms DESC, m.seq DESC LIMIT ?"
    )
    rows = conn.execute(sql, [*params, limit]).fetchall()
    if not rows:
        print("no matches")
        return
    for row in rows:
        stamp = (row["iso"] or "")[:19].replace("T", " ")
        label = row["tool"] or row["type"] or ""
        print(f"{stamp}  [{row['session_id'][:8]}] {row['type']}/{label}")
        for text in (row["content"], row["reasoning"]):
            snippet = excerpt(text or "", query) if query else " ".join((text or "").split())[:110]
            if snippet:
                print(f"    {snippet}")
    label = repr(query) if query else "(filters only)"
    print(f"\n{len(rows)} match(es) for {label}" + ("" if not query or (fts and len(query) >= 3) else " (LIKE fallback)"))


def excerpt(text: str, query: str, width: int = 90) -> str:
    """One-line window around the first hit, so hits deep in a note stay readable."""
    flat = " ".join(text.split())
    if not flat:
        return ""
    idx = flat.lower().find(query.lower())
    if idx < 0:
        return flat[:width] + ("…" if len(flat) > width else "")
    start = max(0, idx - width // 2)
    end = min(len(flat), idx + len(query) + width // 2)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


def cmd_sessions(conn: sqlite3.Connection, limit: int) -> None:
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY last_ms DESC LIMIT ?", (limit,)
    ).fetchall()
    if not rows:
        print("no sessions yet")
        return
    print(f"{'session':10}  {'last':19}  {'events':>6}  {'model':16}  first message")
    for row in rows:
        preview = " ".join((row["first_user"] or "").split())[:44]
        print(
            f"{row['id'][:8]:10}  {row['last_at'] or '':19}  {row['events']:>6}  "
            f"{(row['model'] or '')[:16]:16}  {preview}"
        )


def cmd_show(conn: sqlite3.Connection, prefix: str) -> None:
    matches = conn.execute(
        "SELECT id FROM sessions WHERE id LIKE ? ORDER BY last_ms DESC", (prefix + "%",)
    ).fetchall()
    if not matches:
        sys.exit(f"no session starts with {prefix!r}")
    if len(matches) > 1:
        sys.exit(f"ambiguous prefix {prefix!r}: {', '.join(m['id'][:8] for m in matches)}")
    session_id = matches[0]["id"]
    rows = conn.execute(
        # ts first: older builds restarted `seq` mid-session when the plugin was
        # reloaded, so seq alone can interleave two runs of the same conversation.
        "SELECT * FROM messages WHERE session_id = ? ORDER BY ts_ms, seq", (session_id,)
    ).fetchall()
    print(f"# session {session_id} ({len(rows)} events)\n")
    for row in rows:
        stamp = (row["iso"] or "")[:19].replace("T", " ")
        etype = row["type"]
        if etype == "user":
            print(f"## [{stamp}] user\n{row['content']}\n")
        elif etype == "assistant":
            if row["reasoning"]:
                print(f"> reasoning: {' '.join(row['reasoning'].split())[:300]}")
            print(f"## [{stamp}] assistant\n{row['content']}\n")
        elif etype == "tool_call":
            print(f"- [{stamp}] tool_call {row['tool']} {row['args']}")
        elif etype == "tool_result":
            status = "ok" if row["ok"] else "FAILED"
            ms = f" {row['duration_ms']}ms" if row["duration_ms"] is not None else ""
            body = " ".join((row["content"] or "").split())[:200]
            print(f"- [{stamp}] tool_result {row['tool']} {status}{ms}: {body}")
        else:
            print(f"- [{stamp}] {etype}: {' '.join((row['content'] or '').split())[:200]}")


def cmd_stats(conn: sqlite3.Connection) -> None:
    def scalar(sql: str) -> object:
        return conn.execute(sql).fetchone()[0]

    total = scalar("SELECT COUNT(*) FROM messages")
    if not total:
        print("empty database — run an import first")
        return
    print(f"events:   {total}")
    print(f"sessions: {scalar('SELECT COUNT(*) FROM sessions')}")
    print(f"range:    {scalar('SELECT MIN(iso) FROM messages')} .. {scalar('SELECT MAX(iso) FROM messages')}")
    print("\nby type:")
    for row in conn.execute("SELECT type, COUNT(*) AS n FROM messages GROUP BY type ORDER BY n DESC"):
        print(f"  {row['type'] or '?':12} {row['n']}")
    print("\ntop tools:")
    for row in conn.execute(
        "SELECT tool, COUNT(*) AS n FROM messages WHERE type = 'tool_call' GROUP BY tool ORDER BY n DESC LIMIT 10"
    ):
        print(f"  {row['tool'] or '?':16} {row['n']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jsonl", help="path to history.jsonl (default: auto-discover)")
    parser.add_argument("--vault", help="vault root; implies <vault>/.obsidian/plugins/vault-agent/history.jsonl")
    parser.add_argument("--db", help="path to history.db (default: next to the JSONL)")

    sub = parser.add_subparsers(dest="command")
    sub.add_parser("import", help="ingest new events into SQLite (default)")
    search = sub.add_parser("search", help="full-text search across messages")
    search.add_argument("query", nargs="?", help="text to look for; omit to list by filters only")
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--session", help="restrict to a session-id prefix")
    search.add_argument("--type", help="restrict to an event type (user/assistant/tool_call/tool_result/error)")
    search.add_argument("--tool", help="restrict to a tool name (e.g. read_note)")
    sessions = sub.add_parser("sessions", help="list conversations")
    sessions.add_argument("--limit", type=int, default=30)
    show = sub.add_parser("show", help="print one conversation as a transcript")
    show.add_argument("session", help="session id or unique prefix")
    sub.add_parser("stats", help="totals and per-tool counts")

    args = parser.parse_args()
    jsonl_path = discover_jsonl(args.jsonl, args.vault)
    db_path = Path(args.db).expanduser() if args.db else jsonl_path.with_name(DB_NAME)

    command = args.command or "import"
    if command == "import":
        # Check before connecting: a typo'd path should not create a stray
        # database tree next to it.
        if not jsonl_path.exists():
            sys.exit(f"no transcript yet: {jsonl_path}\n(open Vault Agent in Obsidian and send a message first)")
        conn = connect(db_path, create=True)
        cmd_import(conn, jsonl_path, fts=ensure_fts(conn))
        return

    conn = connect(db_path, create=False)
    fts = ensure_fts(conn)
    if command == "search":
        cmd_search(conn, args.query, fts=fts, limit=args.limit, session=args.session,
                   etype=args.type, tool=args.tool)
    elif command == "sessions":
        cmd_sessions(conn, args.limit)
    elif command == "show":
        cmd_show(conn, args.session)
    elif command == "stats":
        cmd_stats(conn)


if __name__ == "__main__":
    main()
