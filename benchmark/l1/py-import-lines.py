# Lines taken by import statements and __all__ in each .py file -> JSON {file: [lines]}
# Usage: python3 -I py-import-lines.py <root> <out.json>
import ast, json, os, sys
root, out = sys.argv[1], sys.argv[2]
res = {}
for d, _, fs in os.walk(root):
    if any(p in d for p in (".git", "node_modules", ".cantus")): continue
    for f in fs:
        if not f.endswith(".py"): continue
        p = os.path.join(d, f); rel = os.path.relpath(p, root).replace(os.sep, "/")
        try: t = ast.parse(open(p, encoding="utf8").read())
        except Exception: continue
        lines = set()
        for n in ast.walk(t):
            if isinstance(n, (ast.Import, ast.ImportFrom)): lines.update(range(n.lineno, n.end_lineno + 1))
            if isinstance(n, ast.Assign) and any(isinstance(x, ast.Name) and x.id == "__all__" for x in n.targets): lines.update(range(n.lineno, n.end_lineno + 1))
        res[rel] = sorted(lines)
json.dump(res, open(out, "w"))
