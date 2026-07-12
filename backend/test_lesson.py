"""Exercise the per-section lesson planner on a deep topic and validate output.
Run:  python test_lesson.py "how neural networks learn (backpropagation)"
"""
import os, sys, json, time
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Load key from .env (single-line, no trailing newline — dotenv chokes on it)
raw = open(os.path.join(os.path.dirname(__file__), '.env')).read().strip()
API_KEY = raw.split('=', 1)[1].strip() if '=' in raw else ''

# Django setup so we can import the app module directly.
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
import django  # noqa: E402
django.setup()

from agents.lesson_planner import lesson_outline, plan_section  # noqa: E402


def approx_tokens(obj) -> int:
    return len(json.dumps(obj)) // 4  # rough chars/4 heuristic


def validate_section(sec: dict) -> list:
    """Return a list of problems (empty = valid)."""
    problems = []
    shapes = sec.get('shapes', [])
    beats = sec.get('beats', [])
    ids = {s.get('id') for s in shapes if s.get('id')}
    if not shapes:
        problems.append('no shapes')
    if not beats:
        problems.append('no beats')
    revealed = set()
    for i, b in enumerate(beats):
        for rid in b.get('reveal', []) + b.get('emphasize', []):
            if rid not in ids:
                problems.append(f'beat {i} references unknown id "{rid}"')
        revealed.update(b.get('reveal', []))
    never = ids - revealed
    if never:
        problems.append(f'{len(never)} shapes never revealed: {sorted(never)[:6]}')
    return problems


def main():
    topic = sys.argv[1] if len(sys.argv) > 1 else 'how neural networks learn (backpropagation)'
    print(f'\n=== TOPIC: {topic} ===\n')

    t = time.time()
    outline = lesson_outline(topic, API_KEY)
    print(f"OUTLINE ({time.time()-t:.1f}s) — {outline.get('title')!r}")
    sections = outline.get('sections', [])
    for s in sections:
        print(f"  [{s.get('id')}] {s.get('title')}  —  {s.get('goal')}")

    prior = []
    total_problems = 0
    for s in sections:
        t = time.time()
        sec = plan_section(topic, s, prior, API_KEY)
        dt = time.time() - t
        shapes, beats = sec.get('shapes', []), sec.get('beats', [])
        problems = validate_section(sec)
        total_problems += len(problems)
        print(f"\n--- SECTION [{s.get('id')}] {s.get('title')}  ({dt:.1f}s, "
              f"{len(shapes)} shapes, {len(beats)} beats, ~{approx_tokens(sec)} tok) ---")
        for i, b in enumerate(beats):
            rv = ','.join(b.get('reveal', []))
            print(f"  beat{i}: \"{b.get('say','')}\"")
            print(f"         reveal[{rv}]" + (f" emph[{','.join(b['emphasize'])}]" if b.get('emphasize') else ''))
        if problems:
            print(f"  ⚠ PROBLEMS: {problems}")
        else:
            print("  ✓ valid (every beat id exists; every shape revealed)")
        prior.append(s)

    print(f"\n===== {len(sections)} sections, {total_problems} total validation problems =====")


if __name__ == '__main__':
    main()
