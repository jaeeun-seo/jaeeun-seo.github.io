# Deploys the backend to both web app deployments:
#   public - access "Anyone" (used by the GitHub Pages booking page)
#   admin  - access "Only myself" (admin page, Google login enforced by Google)
# Both run the same code; the admin deployment is a version whose manifest
# says access=MYSELF. Usage (from this folder):  ./deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$PUBLIC_ID = 'AKfycbw7Nm_15oeHDtCr2i7reBnE9mphwk5NCDI3YVO7tvZHOOkGN9CRbgudSxuG0FQITQENpg'
$adminFile = Join-Path $PSScriptRoot '.admin-deployment'
$manifest = Get-Content appsscript.json -Raw

clasp push --force
clasp update-deployment $PUBLIC_ID --description "public"

try {
  ($manifest -replace '"ANYONE_ANONYMOUS"', '"MYSELF"') | Set-Content appsscript.json -NoNewline
  clasp push --force
  if (Test-Path $adminFile) {
    clasp update-deployment (Get-Content $adminFile -Raw).Trim() --description "admin"
  } else {
    $out = clasp create-deployment --description "admin" | Out-String
    if ($out -notmatch '(AKfy[\w-]+)') { throw "Could not read admin deployment id: $out" }
    Set-Content $adminFile $Matches[1] -NoNewline
  }
} finally {
  $manifest | Set-Content appsscript.json -NoNewline
  clasp push --force | Out-Null   # leave HEAD on the public manifest
}

$adminId = (Get-Content $adminFile -Raw).Trim()
Write-Host ""
Write-Host "Public API : https://script.google.com/macros/s/$PUBLIC_ID/exec"
Write-Host "Admin page : https://script.google.com/macros/s/$adminId/exec"
