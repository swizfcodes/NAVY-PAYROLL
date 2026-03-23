# bin/ — Bundled Binaries

Committed to the repo so servers install without internet access.
Run `chunk-runner.ps1` and copy OpenSSL/WinSW files ONCE on your dev machine,
then commit. Every server install after that needs no internet.

---

## Required Files

### bin/winsw.exe
Windows Service Wrapper.

Download:
  https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe
Rename to winsw.exe → place in bin/

### bin/openssl.exe + DLLs
SSL certificate generator.

Install OpenSSL MSI from:
  https://slproweb.com/products/Win32OpenSSL.html  (Win64 full version)

Then copy from C:\Program Files\OpenSSL-Win64\bin\ to bin/:
  openssl.exe
  libssl-3-x64.dll
  libcrypto-3-x64.dll

### bin/runner/ (chunks)
GitHub Actions self-hosted runner split into ~50MB chunks.

Run this ONCE on your dev machine from the project root:
  powershell -ExecutionPolicy Bypass -File chunk-runner.ps1

This downloads the runner zip, splits it into chunks, and saves to bin/runner/.

---

## .env.local additions required

Add these to .env.local before running setup.bat:

  GITHUB_PAT=your_github_personal_access_token
  GITHUB_REPO=hicadsystems/NAVY-PAYROLL

GITHUB_PAT needs repo scope:
  GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
  Permissions: Actions (read/write), Administration (read/write)

---

## After adding all files

  git add bin/
  git commit -m "add bundled binaries and runner chunks"
  git push

---

## .gitignore note

bin/ must NOT be in .gitignore — these files must be tracked.