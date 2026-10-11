// Minimal glob matcher for the small, simple patterns used in config/strategies.yaml
// (e.g. "**/auth/**", "**/*secret*"). Not a full glob implementation — deliberately so,
// to avoid a dependency for four straightforward patterns.
//
// Deliberate deviation from standard glob semantics: a single `*` here crosses path
// separators, same as `**` — there's no distinct "single path segment" wildcard. These globs
// are used for security-risk classification (config/strategies.yaml's securityPathGlobs), and
// a strict single-segment `*` silently fails to match substring patterns like `**/*secret*`
// against e.g. "src/secrets/keys.js" (the trailing `[^/]*` can't cross the `/` after
// "secrets" to reach the rest of the path). For this use case, under-matching is the
// dangerous failure mode — a real secret/credential path could go unflagged — so matching too
// broadly is the safer default.
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      re += '.*';
      if (glob[i + 1] === '*') i++;
      if (glob[i + 1] === '/') i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // "tests/" names a directory, as planners write it in targetGlobs: it covers what is under it.
  if (glob.endsWith('/')) re += '.*';
  re += '$';
  return new RegExp(re);
}

export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g).test(normalized));
}
