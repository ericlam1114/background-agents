#!/bin/bash
set -e
echo "Running: npm run lint 2>&1"
npm run lint 2>&1
echo "Running: npm run build 2>&1"
npm run build 2>&1
echo "All checks passed."
