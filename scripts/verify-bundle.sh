#!/usr/bin/env bash
#
# Proves the shipped extension carries no proprietary logic and no secrets.
#
# Run it before every release and after any change to extension/. It greps the
# actual bundle for the things that must never appear there, so a formula
# reintroduced by a careless copy-paste fails the build rather than shipping.
#
#   ./scripts/verify-bundle.sh
#
# Exit status 0 means clean; 1 means something leaked.

set -uo pipefail

BUNDLE="${1:-extension}"
FAILURES=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# Only files that actually ship. lib/ is included; nothing else is excluded,
# because anything sitting in extension/ ends up in the .zip.
mapfile -t FILES < <(find "$BUNDLE" -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.css' \) | sort)

bold "Scanning ${#FILES[@]} shipped files in $BUNDLE/"
echo

check() {
  local label="$1" pattern="$2"
  local hits
  hits=$(grep -rEn "$pattern" "${FILES[@]}" 2>/dev/null || true)

  if [[ -n "$hits" ]]; then
    red "FAIL  $label"
    sed 's/^/        /' <<<"$hits" | head -12
    FAILURES=$((FAILURES + 1))
  else
    green "pass  $label"
  fi
}

bold "1. Scoring model"
# The six V19 coefficients, by value. Any one of them appearing is a leak.
check "no V19 badge-model coefficients"    '2\.637617154|0\.01072047|0\.13099998|0\.86298248|0\.19508055|0\.1185108'
check "no V19 no-badge-model coefficients" '6\.424250557|0\.28777473|0\.23086161|0\.42218872|0\.70887953'
check "no confidence-band multipliers"     '\*[[:space:]]*(\.68|0\.68|1\.45|\.40|0\.40|2\.10)\b'
check "no exp/log demand maths"            'Math\.(exp|log1p)\('
check "no rank calibration table"          '\[500,[[:space:]]*803\]|724,[[:space:]]*611|10000,[[:space:]]*54'

echo
bold "2. Advisory thresholds"
check "no price-position multipliers"   'premiumPriceMultiple|lowPriceMultiple|1\.20[[:space:]]*\*|0\.80[[:space:]]*\*'
check "no advisory tuning constants"    'thinMoatShareMultiple|assortmentGapMultiple|fbaShareFloor|ratingGapTolerance|shareGapTolerance'
check "no HHI formula"                  'Math\.pow\([^,]*share[^,]*,[[:space:]]*2\)|hhi[[:space:]]*\+='

echo
bold "3. Credentials"
# A service-role JWT decodes to {"role":"service_role"}; base64 of that fragment
# is cm9sZSI6InNlcnZpY2Vfcm9sZQ. Catch both the raw and encoded forms.
check "no service_role key"          'service_role|cm9sZSI6InNlcnZpY2Vfcm9sZQ|SUPABASE_SERVICE_ROLE'
check "no database connection string" 'postgres(ql)?://|db\..*\.supabase\.co:[0-9]+'
check "no generic API keys"          '(sk|pk)_(live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-'
check "no private key material"      'BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY'

echo
bold "4. Customer data"
check "no embedded product dataset" '"Parent Level Sales Unit"|"ASIN Sales Unit"|Helium_10_Xray'

echo
bold "5. Expected contents"
# The inverse check: the two values that SHOULD be present. If the anon key
# went missing the extension would be broken in a way the checks above cannot
# see, so assert it is there.
if grep -rq 'SUPABASE_ANON_KEY' "$BUNDLE/config.js" && grep -rq 'SUPABASE_URL' "$BUNDLE/config.js"; then
  green "pass  project URL and anon key present in config.js"
else
  red   "FAIL  config.js is missing the project URL or anon key"
  FAILURES=$((FAILURES + 1))
fi

# Everything the extension reaches must go through the service worker.
STRAY=$(grep -rEln 'fetch\(' "${FILES[@]}" 2>/dev/null \
  | grep -vE 'background\.js|lib/(session|api|amazon)\.js' || true)
if [[ -n "$STRAY" ]]; then
  red "FAIL  fetch() outside the service worker layer"
  sed 's/^/        /' <<<"$STRAY"
  FAILURES=$((FAILURES + 1))
else
  green "pass  all network calls confined to the service worker"
fi

echo
if [[ $FAILURES -eq 0 ]]; then
  green "All checks passed. The bundle carries no formulas, thresholds or secrets."
  exit 0
fi

red "$FAILURES check(s) failed. Do not ship this bundle."
exit 1
