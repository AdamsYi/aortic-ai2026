$ErrorActionPreference = "Stop"

$TunnelId = "5c169115-689e-4eaf-850c-970bebefb49c"
$ZoneName = "heartvalvepro.edu.kg"
$RecordName = "api"
$RecordFqdn = "$RecordName.$ZoneName"
$RecordTarget = "$TunnelId.cfargotunnel.com"
$ConfigPath = "C:\Users\Admin\.cloudflared\config.yml"
$CredentialsPath = "C:\Users\Admin\.cloudflared\$TunnelId.json"

function Fail($Message, $ErrorDetail) {
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  if ($ErrorDetail) {
    Write-Host $ErrorDetail -ForegroundColor DarkRed
  }
  exit 1
}

try {
  $Email = Read-Host "Cloudflare account email"
  $ApiKeySecure = Read-Host "Cloudflare Global API Key" -AsSecureString
  $ApiKeyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKeySecure)
  $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ApiKeyPtr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ApiKeyPtr)

  if ([string]::IsNullOrWhiteSpace($Email) -or [string]::IsNullOrWhiteSpace($ApiKey)) {
    Fail "Email and Global API Key are required." $null
  }

  $Headers = @{
    "X-Auth-Email" = $Email
    "X-Auth-Key"   = $ApiKey
    "Content-Type" = "application/json"
  }

  $ZoneResponse = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/zones?name=$ZoneName" -Headers $Headers
  if (-not $ZoneResponse.success -or -not $ZoneResponse.result -or $ZoneResponse.result.Count -eq 0) {
    $errors = ($ZoneResponse.errors | ConvertTo-Json -Compress)
    Fail "Failed to resolve zone id for $ZoneName" $errors
  }
  $ZoneId = $ZoneResponse.result[0].id
  Write-Host "Zone ID resolved: $ZoneId"

  $ExistingRecord = Invoke-RestMethod -Method Get -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records?type=CNAME&name=$RecordFqdn" -Headers $Headers
  if ($ExistingRecord.success -and $ExistingRecord.result -and $ExistingRecord.result.Count -gt 0) {
    Write-Host "DNS record already exists for $RecordFqdn. Skipping create."
  } else {
    $Body = @{
      type    = "CNAME"
      name    = $RecordName
      content = $RecordTarget
      proxied = $true
    } | ConvertTo-Json

    $CreateRecord = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records" -Headers $Headers -Body $Body
    if (-not $CreateRecord.success) {
      $errors = ($CreateRecord.errors | ConvertTo-Json -Compress)
      Fail "Failed to create DNS record for $RecordFqdn" $errors
    }
    Write-Host "Created DNS record: $RecordFqdn -> $RecordTarget"
  }

  $CloudflaredDir = Split-Path $ConfigPath -Parent
  if (-not (Test-Path $CloudflaredDir)) {
    New-Item -ItemType Directory -Path $CloudflaredDir -Force | Out-Null
  }

  $ConfigContent = @"
tunnel: $TunnelId
credentials-file: $CredentialsPath
ingress:
  - hostname: $RecordFqdn
    service: http://127.0.0.1:8000
  - service: http_status:404
"@

  Set-Content -Path $ConfigPath -Value $ConfigContent -Encoding UTF8

  Write-Host "Done. GPU API is now accessible at: https://api.heartvalvepro.edu.kg/health" -ForegroundColor Green
  Write-Host "Restart cloudflared for ingress config to take effect." -ForegroundColor Yellow
}
catch {
  $detail = $_ | Format-List * -Force | Out-String
  Fail "Cloudflare setup failed." $detail
}
