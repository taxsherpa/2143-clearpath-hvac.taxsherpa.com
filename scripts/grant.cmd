@echo off
REM Grants, lists or revokes ClearPath HVAC access by hand.
REM
REM WHY THIS FILE EXISTS
REM   Same reason as push-schema.cmd: Railway's DATABASE_URL points at
REM   postgres.railway.internal, which only resolves inside Railway. This maps
REM   DATABASE_PUBLIC_URL onto DATABASE_URL for the length of one command, so no password is
REM   ever pasted or printed. PowerShell also refuses npm's .ps1 shims here, hence node directly.
REM
REM USE (Public Access must be on for the Postgres service while this runs)
REM   railway.cmd run --service Postgres cmd /c scripts\grant.cmd someone@example.com
REM   railway.cmd run --service Postgres cmd /c scripts\grant.cmd someone@example.com --days 90 --apply
REM   railway.cmd run --service Postgres cmd /c scripts\grant.cmd someone@example.com --permanent --apply
REM   railway.cmd run --service Postgres cmd /c scripts\grant.cmd someone@example.com --revoke-manual --apply
REM
REM Without --apply it is a dry run: it prints what it would write and stops.
REM Every grant written here carries source 'manual', so a comp can be revoked without touching
REM a purchase. Purchases arrive through the GHL webhook, never through this script.

if "%DATABASE_PUBLIC_URL%"=="" (
  echo.
  echo DATABASE_PUBLIC_URL is empty.
  echo Run this through the Railway CLI against the Postgres service, with Public Access enabled:
  echo   railway.cmd run --service Postgres cmd /c scripts\grant.cmd ^<email^> [options]
  exit /b 1
)

set DATABASE_URL=%DATABASE_PUBLIC_URL%
node scripts/grant-access.mjs %*
