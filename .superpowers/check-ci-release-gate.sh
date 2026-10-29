#!/usr/bin/env bash
set -eu
export GITHUB_REPOSITORY=tessar-ai/tessar GITHUB_SHA=tagged-commit-sha
export MOCK_CONCLUSION MOCK_GH_EXIT
function gh() {
  local expected=(run list --repo tessar-ai/tessar --workflow ci.yml --branch release --event push --commit tagged-commit-sha --limit 1 --json conclusion --jq '.[0].conclusion // ""')
  [[ "$#" == "${#expected[@]}" ]] || return 93
  local index=0
  for argument in "$@"; do
    [[ "$argument" == "${expected[index]}" ]] || return 94
    index=$((index+1))
  done
  printf '%s\n' "$MOCK_CONCLUSION"
  return "$MOCK_GH_EXIT"
}
export -f gh
for conclusion in success failure cancelled skipped neutral action_required timed_out ''; do
  MOCK_CONCLUSION="$conclusion" MOCK_GH_EXIT=0
  if bash -e .superpowers/ci-release-gate.sh >.superpowers/ci-gate-result.txt 2>&1; then actual=0; else actual=$?; fi
  if [[ "$conclusion" == success ]]; then [[ "$actual" == 0 ]]; else [[ "$actual" != 0 ]]; fi
  printf 'CI conclusion %s: exit %s, correct\n' "${conclusion:-missing-or-pending}" "$actual"
done
MOCK_CONCLUSION=success MOCK_GH_EXIT=1
if bash -e .superpowers/ci-release-gate.sh >.superpowers/ci-gate-result.txt 2>&1; then
  echo 'ERROR: accepted failed GitHub request'; exit 1
fi
echo 'GitHub CLI failure blocks publishing: correct'
