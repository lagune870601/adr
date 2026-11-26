#!/bin/bash
prefix="$1"
shift
"$@" 2>&1 | sed -u "s/^/[$prefix] /"
exit "${PIPESTATUS[0]}"