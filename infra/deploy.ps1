<#
.SYNOPSIS
    Provisions and deploys Azure Code Canvas end to end.

.DESCRIPTION
    Idempotent. Run it as many times as you like — it will create anything that
    is missing and update anything that drifted.

    The deployment happens in three passes because the container images must
    exist in the registry before the Container App and the session pool can
    reference them:

      1. Deploy the registry and managed identity only.
      2. Build both images in the cloud with `az acr build` (no local Docker).
      3. Deploy the full stack: environment, session pool, Container App.

.PARAMETER ResourceGroup
    Resource group to deploy into. Created if it does not exist.

.PARAMETER Location
    Azure region. Must support Container Apps dynamic sessions.

.PARAMETER OpenAiAccountId
    Resource ID of an existing Azure OpenAI account holding the deployments.

.EXAMPLE
    ./infra/deploy.ps1 -ResourceGroup rg-code-canvas `
        -OpenAiAccountId /subscriptions/xxx/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/my-aoai
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $OpenAiAccountId,
    [string] $Location = 'eastus2',
    [string] $AppName = 'codecanvas',
    [string] $OpenAiDeployment = 'gpt-5.6-terra',
    [string] $OpenAiFallbackDeployment = 'gpt-5.5',
    [string] $ImageTag = ('v{0}' -f (Get-Date -Format 'yyyyMMddHHmmss')),
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string] $Message) Write-Host "`n=== $Message" -ForegroundColor Cyan }
function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments)][string[]] $Arguments)
    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "az $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
    return $output
}

# --------------------------------------------------------------- preflight

Write-Step 'Checking prerequisites'
$account = Invoke-Az account show -o json | ConvertFrom-Json
Write-Host "  subscription  $($account.name) ($($account.id))"
Write-Host "  tenant        $($account.tenantId)"

foreach ($provider in @('Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.OperationalInsights')) {
    $state = Invoke-Az provider show -n $provider --query registrationState -o tsv
    if ($state -ne 'Registered') {
        Write-Host "  registering $provider ..."
        Invoke-Az provider register -n $provider --wait | Out-Null
    }
    Write-Host "  provider      $provider = Registered"
}

Write-Step "Ensuring resource group '$ResourceGroup' in $Location"
Invoke-Az group create -n $ResourceGroup -l $Location -o none

# ------------------------------------------------- pass 1: registry + identity

Write-Step 'Pass 1/3 — registry and managed identity'
$suffix = (Invoke-Az group show -n $ResourceGroup --query id -o tsv)
$pass1 = Invoke-Az deployment group create `
    -g $ResourceGroup `
    -n "$AppName-bootstrap" `
    -f (Join-Path $PSScriptRoot 'bootstrap.bicep') `
    -p appName=$AppName location=$Location `
    -o json | ConvertFrom-Json

$registryName = $pass1.properties.outputs.registryName.value
$loginServer = $pass1.properties.outputs.registryLoginServer.value
Write-Host "  registry      $loginServer"

# ------------------------------------------------------- pass 2: build images

if ($SkipBuild) {
    Write-Step 'Pass 2/3 — skipped (-SkipBuild)'
}
else {
    Write-Step "Pass 2/3 — building images in the cloud (tag $ImageTag)"

    Write-Host '  building studio image ...'
    Invoke-Az acr build `
        --registry $registryName `
        --image "$AppName-studio:$ImageTag" `
        --image "$AppName-studio:latest" `
        --file (Join-Path $root 'Dockerfile') `
        $root -o none

    Write-Host '  building renderd image ...'
    Invoke-Az acr build `
        --registry $registryName `
        --image "$AppName-renderd:$ImageTag" `
        --image "$AppName-renderd:latest" `
        --file (Join-Path $root 'renderd/Dockerfile') `
        (Join-Path $root 'renderd') -o none

    Write-Host "  pushed        $loginServer/$AppName-studio:$ImageTag"
    Write-Host "  pushed        $loginServer/$AppName-renderd:$ImageTag"
}

# ---------------------------------------------------- pass 3: the full stack

Write-Step 'Pass 3/3 — environment, session pool and Container App'
$pass3 = Invoke-Az deployment group create `
    -g $ResourceGroup `
    -n "$AppName-stack" `
    -f (Join-Path $PSScriptRoot 'main.bicep') `
    -p appName=$AppName `
       location=$Location `
       openAiAccountId=$OpenAiAccountId `
       openAiDeployment=$OpenAiDeployment `
       openAiFallbackDeployment=$OpenAiFallbackDeployment `
       imageTag=$ImageTag `
    -o json | ConvertFrom-Json

$outputs = $pass3.properties.outputs

Write-Step 'Deployment complete'
Write-Host ''
Write-Host "  Studio URL        $($outputs.studioUrl.value)" -ForegroundColor Green
Write-Host "  Render pool       $($outputs.renderPoolEndpoint.value)"
Write-Host "  Registry          $($outputs.registryLoginServer.value)"
Write-Host "  Identity client   $($outputs.identityClientId.value)"
Write-Host ''
Write-Host '  Role assignments can take 5-10 minutes to propagate to the data plane.'
Write-Host '  If the first generation returns 401/403, wait and retry.'
Write-Host ''
