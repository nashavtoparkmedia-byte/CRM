@echo off
echo Starting diagnostics... > diag.log
echo Node version: >> diag.log
node -v >> diag.log 2>&1
echo NPM version: >> diag.log
npm -v >> diag.log 2>&1
echo Path: >> diag.log
echo %PATH% >> diag.log
echo Diagnostics finished. >> diag.log
