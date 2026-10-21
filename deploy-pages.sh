#!/bin/sh
# Publish the current working tree to the gh-pages branch.
set -eu
cd "$(dirname "$0")"

git fetch origin gh-pages
worktree="$(mktemp -d)/efb-gh-pages"
git worktree add --detach "$worktree" origin/gh-pages

cp index.html app.js styles.css sw.js manifest.webmanifest .nojekyll "$worktree"/
rm -rf "$worktree/icons"
cp -R icons "$worktree/icons"
rm -rf "$worktree/vendor"
cp -R vendor "$worktree/vendor"

cd "$worktree"
git add -A
if git diff --cached --quiet; then
  echo "No static-file changes to deploy."
else
  git commit -m "Deploy Observer Log $(date '+%Y-%m-%d %H:%M')"
  git push origin HEAD:gh-pages
fi
cd - >/dev/null
git worktree remove --force "$worktree"
echo "Deployed to https://cap-efb.github.io/app/"
