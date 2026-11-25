$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path $PSScriptRoot -Parent
$environmentNames = @(
	'DOCKER_BIND_ADDRESS', 'WEB_API_PORT', 'HTTPS_WEB_PORT', 'PASSKEY_RP_ID',
	'PASSKEY_ORIGIN', 'SESSION_DAYS', 'POSTGRES_PASSWORD'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
	$savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$cases = @(
	@{ Name = 'Blank defaults'; Values = @{}; Override = ''; Bind = '127.0.0.1'; Http = 8080; Https = 4125; Hostname = 'localhost'; Origin = 'https://localhost:4125' }
	@{ Name = 'Custom ports'; Values = @{ DOCKER_BIND_ADDRESS = '192.0.2.10'; WEB_API_PORT = '8123'; HTTPS_WEB_PORT = '9443'; PASSKEY_RP_ID = 'portal.example.com' }; Override = ''; Bind = '192.0.2.10'; Http = 8123; Https = 9443; Hostname = 'portal.example.com'; Origin = 'https://portal.example.com:9443' }
	@{ Name = 'Proxy origin'; Values = @{ PASSKEY_RP_ID = 'portal.example.com'; PASSKEY_ORIGIN = 'https://portal.example.com' }; Override = ''; Bind = '127.0.0.1'; Http = 8080; Https = 4125; Hostname = 'portal.example.com'; Origin = 'https://portal.example.com' }
	@{ Name = 'Development'; Values = @{ HTTPS_WEB_PORT = '9443'; PASSKEY_RP_ID = 'portal.example.com' }; Override = 'compose.dev.yaml'; Bind = '127.0.0.1'; Http = 8080; Https = 9443; Hostname = 'portal.example.com'; Origin = 'https://portal.example.com:9443' }
	@{ Name = 'Public HTTPS'; Values = @{ DOCKER_BIND_ADDRESS = '0.0.0.0'; PASSKEY_RP_ID = 'portal.example.com' }; Override = 'compose.https.yaml'; Bind = '0.0.0.0'; Http = 80; Https = 443; Hostname = 'portal.example.com'; Origin = 'https://portal.example.com' }
)

Push-Location $root
try {
	foreach ($case in $cases) {
		foreach ($name in $environmentNames) {
			[Environment]::SetEnvironmentVariable($name, '', 'Process')
		}
		foreach ($name in $case.Values.Keys) {
			[Environment]::SetEnvironmentVariable($name, $case.Values[$name], 'Process')
		}
		$arguments = @('compose', '--env-file', '.envexample', '-f', 'compose.yaml')
		if ($case.Override) {
			$arguments += @('-f', $case.Override)
		}
		$configText = & docker @arguments config --format json
		if ($LASTEXITCODE -ne 0) { throw "$($case.Name): Compose configuration failed" }
		$config = ($configText -join "`n") | ConvertFrom-Json
		$gateway = $config.services.gateway
		if ($gateway.environment.DOCKER_BIND_ADDRESS -ne $case.Bind) {
			throw "$($case.Name): bind address was not passed to gateway certificate configuration"
		}
		if ($gateway.environment.PORTAL_ADDRESS -ne "https://$($case.Hostname)" -or
			$gateway.environment.PUBLIC_ORIGIN -ne $case.Origin -or
			$config.services.portal.environment.PASSKEY_ORIGIN -ne $case.Origin) {
			throw "$($case.Name): wrong gateway or portal origin"
		}
		foreach ($mapping in @(
			@{ Target = 80; Published = $case.Http; Protocol = 'tcp' }
			@{ Target = 443; Published = $case.Https; Protocol = 'tcp' }
			@{ Target = 443; Published = $case.Https; Protocol = 'udp' }
		)) {
			$match = @($gateway.ports | Where-Object {
				$_.host_ip -eq $case.Bind -and $_.target -eq $mapping.Target -and
				$_.published -eq [string]$mapping.Published -and $_.protocol -eq $mapping.Protocol
			})
			if ($match.Count -ne 1) { throw "$($case.Name): wrong port mapping" }
		}
		Write-Host "PASS: $($case.Name)"
	}
} finally {
	Pop-Location
	foreach ($name in $environmentNames) {
		[Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
	}
}
