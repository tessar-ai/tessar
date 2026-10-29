conclusion=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml \
  --branch release --event push --commit "$GITHUB_SHA" --limit 1 \
  --json conclusion --jq '.[0].conclusion // ""')
if [ "$conclusion" != success ]; then
  echo "::error::Commit $GITHUB_SHA must pass CI on release before publishing. Wait for CI or fix it, then re-run this release."
  exit 1
fi
