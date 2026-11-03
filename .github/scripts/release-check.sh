#!/usr/bin/env bash
# Checks a release and packages it, without publishing anything.
#
# The release workflow's build job runs this, and so can anyone on their own machine:
#
#   .github/scripts/release-check.sh            # dry run: whatever version package.json holds
#   .github/scripts/release-check.sh v0.10.1    # as the workflow runs it for that tag
#
# With a tag it fails unless the tag is "v" + package.json's version and CHANGELOG.md
# has a dated heading for that version. Without one it only warns about the heading.
# It then runs the tests, packages the .vsix into dist/, and writes dist/release-notes.md
# (the CHANGELOG section for the version), dist/SHA256SUMS and the facts below.
# It never publishes and needs no token.
set -euo pipefail

cd "$(dirname "$0")/../.."

tag="${1:-}"
version="$(node -p "require('./package.json').version")"
name="$(node -p "require('./package.json').name")"

fail() { echo "release-check: $*" >&2; exit 1; }

if [ -n "$tag" ]; then
  [ "$tag" = "v$version" ] || fail "tag $tag does not match package.json version $version"
fi

heading="$(grep -E "^## v${version//./\\.}( |$)" CHANGELOG.md || true)"
if [ -z "$heading" ]; then
  fail "CHANGELOG.md has no '## v$version' heading"
fi
if ! printf '%s\n' "$heading" | grep -Eq "^## v${version//./\\.} — [0-9]{4}-[0-9]{2}-[0-9]{2}$"; then
  if [ -n "$tag" ]; then
    fail "CHANGELOG.md heading is not dated: '$heading' (want '## v$version — YYYY-MM-DD')"
  fi
  echo "release-check: warning: heading not dated yet: '$heading'"
fi

if ! npx --no-install vsce publish --help | grep -q -- '--oidc'; then
  fail "the locked @vscode/vsce has no --oidc (trusted publishing needs 4.1.0 or later)"
fi
if ! npx --no-install ovsx publish --help | grep -q -- '--trusted-publishing'; then
  fail "the locked ovsx has no --trusted-publishing (needs 1.3.0 or later in devDependencies)"
fi

npm test

rm -rf dist
mkdir -p dist
vsix="dist/$name-$version.vsix"
npx --no-install vsce package --out "$vsix"

# The CHANGELOG section for this version, without its heading: the GitHub Release notes.
awk -v v="## v$version" '
  index($0, v) == 1 && (length($0) == length(v) || substr($0, length(v) + 1, 1) == " ") { on = 1; next }
  on && /^## / { exit }
  on { print }
' CHANGELOG.md | sed -e '/./,$!d' > dist/release-notes.md
[ -s dist/release-notes.md ] || fail "the CHANGELOG section for v$version is empty"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }

(cd dist && sha "$(basename "$vsix")" > SHA256SUMS)

unpacked="$(mktemp -d)"
trap 'rm -rf "$unpacked"' EXIT
unzip -q "$vsix" -d "$unpacked"

echo
echo "== release facts =="
echo "version:           $version"
echo "tag:               ${tag:-(none: dry run)}"
echo "commit:            $(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "vsix:              $vsix"
echo "vsix sha256:       $(cut -d' ' -f1 dist/SHA256SUMS)"
echo "out/extension.js:  $(sha "$unpacked/extension/out/extension.js" | cut -d' ' -f1)"
echo "files in package:  $(cd "$unpacked" && find . -type f | wc -l | tr -d ' ')"
(cd "$unpacked" && find . -type f | sort | sed 's/^/  /')
echo "release notes:     dist/release-notes.md ($(wc -l < dist/release-notes.md | tr -d ' ') lines)"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$version"
    echo "vsix=$(basename "$vsix")"
  } >> "$GITHUB_OUTPUT"
fi
