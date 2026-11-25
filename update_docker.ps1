param(
	[switch]$NoPull,
	[switch]$cm,
	[string]$mcm
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-DockerCommand {
	param([string[]]$Arguments)
	& docker @Arguments
	if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. The update stopped without removing any volumes.' }
}

Push-Location $PSScriptRoot
try {
	if (-not $NoPull) {
		git pull --ff-only
		if ($LASTEXITCODE -ne 0) { throw 'git pull failed; no Docker services were changed.' }
		if ($cm) {
			# Run github copilot prompt to auto generate commit message and push
			copilot -p "Add all the change and push a commit with message description of the recent changes" --allow-all
		} elseif ($PSBoundParameters.ContainsKey('mcm')) {
			git add .
			if ($LASTEXITCODE -ne 0) { throw 'git add failed; no Docker services were changed.' }
			git commit -am $mcm
			if ($LASTEXITCODE -ne 0) { throw 'git commit failed; no Docker services were changed.' }
			git push
			if ($LASTEXITCODE -ne 0) { throw 'git push failed; no Docker services were changed.' }
		}
		
	}
	Invoke-DockerCommand -Arguments @('compose', 'config', '--quiet')
	Invoke-DockerCommand -Arguments @('compose', 'build')
	Invoke-DockerCommand -Arguments @('compose', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
	Write-Host 'Update complete. The portal, gateway, Grocy, and webtrees are ready.'
} finally {
	Pop-Location
}