$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$updateScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'update_docker.ps1'
$state = [pscustomobject]@{
	Calls = [System.Collections.Generic.List[string]]::new()
	GitExitCode = 0
	DockerFailure = ''
}

Set-Item Function:git {
	$state.Calls.Add('git ' + ($args -join ' '))
	$global:LASTEXITCODE = $state.GitExitCode
}.GetNewClosure()

Set-Item Function:docker {
	$command = 'docker ' + ($args -join ' ')
	$state.Calls.Add($command)
	$global:LASTEXITCODE = if ($command -eq $state.DockerFailure) { 1 } else { 0 }
}.GetNewClosure()

$dockerCommands = @(
	'docker compose config --quiet'
	'docker compose build'
	'docker compose up -d --no-build --wait --wait-timeout 180'
)
$cases = @(
	@{ Name = 'No arguments'; Parameters = @{}; GitExit = 0; DockerFailure = ''; Expected = @('git pull --ff-only') + $dockerCommands; Error = '' }
	@{ Name = 'NoPull'; Parameters = @{ NoPull = $true }; GitExit = 0; DockerFailure = ''; Expected = $dockerCommands; Error = '' }
	@{ Name = 'Git failure'; Parameters = @{}; GitExit = 1; DockerFailure = ''; Expected = @('git pull --ff-only'); Error = 'git pull failed' }
	@{ Name = 'Config failure'; Parameters = @{}; GitExit = 0; DockerFailure = $dockerCommands[0]; Expected = @('git pull --ff-only', $dockerCommands[0]); Error = 'Docker command failed' }
	@{ Name = 'Build failure'; Parameters = @{}; GitExit = 0; DockerFailure = $dockerCommands[1]; Expected = @('git pull --ff-only', $dockerCommands[0], $dockerCommands[1]); Error = 'Docker command failed' }
	@{ Name = 'Readiness failure'; Parameters = @{}; GitExit = 0; DockerFailure = $dockerCommands[2]; Expected = @('git pull --ff-only') + $dockerCommands; Error = 'Docker command failed' }
)

Push-Location $env:TEMP
try {
	foreach ($case in $cases) {
		$state.Calls.Clear()
		$state.GitExitCode = $case.GitExit
		$state.DockerFailure = $case.DockerFailure
		$parameters = $case.Parameters
		$originalLocation = (Get-Location).Path
		$errorMessage = ''
		try {
			& $updateScript @parameters
		} catch {
			$errorMessage = $_.Exception.Message
		}
		if (($state.Calls -join "`n") -cne ($case.Expected -join "`n")) {
			throw "$($case.Name): unexpected commands: $($state.Calls -join '; '); error: $errorMessage"
		}
		if (($case.Error -eq '' -and $errorMessage -ne '') -or
			($case.Error -ne '' -and -not $errorMessage.StartsWith($case.Error))) {
			throw "$($case.Name): unexpected error: $errorMessage"
		}
		if ((Get-Location).Path -ne $originalLocation) {
			throw "$($case.Name): working directory was not restored"
		}
		Write-Host "PASS: $($case.Name)"
	}
} finally {
	Pop-Location
}
