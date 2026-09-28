// ===========================================================================
// Azure Code Canvas — full infrastructure.
//
// Deploys a generative-UI studio where a user types a prompt, an Azure OpenAI
// GPT model writes a web app, and that app is rendered live inside a
// disposable, Hyper-V isolated micro-VM.
//
//   ┌── Container App: canvas studio (the website users visit) ──────────────┐
//   │  left    chat        -> Azure OpenAI (managed identity, no keys)       │
//   │  middle  source code -> streamed from the model token by token         │
//   │  right   live render -> proxied out of a dynamic session micro-VM      │
//   └────────────────────────────────────────────────────────────────────────┘
//
// Each render gets its own session in the pool: click "new", get a fresh
// container. Sessions are allocated from a warm pool in milliseconds and are
// reclaimed automatically once idle.
//
// Deploy:
//   az deployment group create -g <rg> -f infra/main.bicep -p infra/main.parameters.json
// ===========================================================================

targetScope = 'resourceGroup'

// --------------------------------------------------------------- parameters

@description('Short name used to derive every resource name. Lowercase letters and digits only.')
@minLength(3)
@maxLength(12)
param appName string = 'codecanvas'

@description('Azure region for all resources. Must support Container Apps dynamic sessions.')
param location string = resourceGroup().location

@description('Resource ID of an existing Azure OpenAI (Cognitive Services) account.')
param openAiAccountId string

@description('Primary Azure OpenAI deployment name used for generation.')
param openAiDeployment string = 'gpt-5.6-terra'

@description('Fallback deployment used automatically if the primary errors or throttles.')
param openAiFallbackDeployment string = 'gpt-5.5'

@description('Reasoning effort for gpt-5 class deployments.')
@allowed(['minimal', 'low', 'medium', 'high'])
param openAiReasoningEffort string = 'medium'

@description('Container image tag to deploy. Use a unique tag per build; :latest is not re-pulled by session pools.')
param imageTag string = 'v1'

@description('Maximum number of render sessions alive at once.')
@minValue(1)
@maxValue(600)
param maxConcurrentSessions int = 100

@description('Number of pre-warmed sessions kept ready for instant allocation.')
@minValue(0)
@maxValue(100)
param readySessionInstances int = 5

@description('Seconds a render session may sit idle before it is destroyed. Must be 300-3600.')
@minValue(300)
@maxValue(3600)
param sessionCooldownSeconds int = 600

@description('Minimum studio replicas. Keep at 1 so the first request is never a cold start.')
@minValue(0)
param studioMinReplicas int = 1

@description('Maximum studio replicas.')
@minValue(1)
param studioMaxReplicas int = 5

@description('Log Analytics retention in days.')
param logRetentionDays int = 30

// ----------------------------------------------------------------- naming

var suffix = uniqueString(resourceGroup().id)
var registryName = '${appName}acr${suffix}'
var identityName = 'id-${appName}'
var environmentName = 'cae-${appName}'
var workspaceName = 'log-${appName}'
var studioAppName = 'ca-${appName}-studio'
// Session pool names must match ^[a-z][a-z0-9]*$ — no hyphens permitted.
var renderPoolName = '${appName}render'
var studioImage = '${registry.properties.loginServer}/${appName}-studio:${imageTag}'
var renderImage = '${registry.properties.loginServer}/${appName}-renderd:${imageTag}'

// Built-in role definition IDs.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var sessionExecutorRoleId = '0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0'

// ------------------------------------------------------------------ identity

// A single user-assigned identity is the app's entire security story: it pulls
// images, calls Azure OpenAI, and executes render sessions. No keys anywhere.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

// ------------------------------------------------------------------ registry

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ----------------------------------------------------------------- telemetry

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

// --------------------------------------------------------------- environment

// Custom-container session pools require a workload-profiles-enabled
// environment, so the Consumption profile is declared explicitly.
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

// -------------------------------------------------------------- render pool

// The heart of the demo. Every artifact is handed to its own session: a
// Hyper-V isolated micro-VM with its own kernel, filesystem and network
// namespace. Egress is disabled, so model-authored code cannot call out.
resource renderPool 'Microsoft.App/sessionPools@2024-10-02-preview' = {
  name: renderPoolName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    scaleConfiguration: {
      maxConcurrentSessions: maxConcurrentSessions
      readySessionInstances: readySessionInstances
    }
    // NOTE: api-version 2024-10-02-preview takes the flat shape below.
    // 2025-02-02-preview and later nest these under `lifecycleConfiguration`
    // and rename `executionType` to `lifecycleType`. Do not mix the two.
    dynamicPoolConfiguration: {
      executionType: 'Timed'
      cooldownPeriodInSeconds: sessionCooldownSeconds
    }
    customContainerTemplate: {
      registryCredentials: {
        server: registry.properties.loginServer
        identity: identity.id
      }
      containers: [
        {
          name: 'renderd'
          image: renderImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      ingress: {
        targetPort: 8080
      }
    }
    // Untrusted, model-authored code runs here. Never enable egress.
    sessionNetworkConfiguration: {
      status: 'EgressDisabled'
    }
  }
  dependsOn: [
    acrPull
  ]
}

resource sessionExecutor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: renderPool
  name: guid(renderPool.id, identity.id, sessionExecutorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sessionExecutorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ------------------------------------------------------------- studio app

resource studio 'Microsoft.App/containerApps@2024-03-01' = {
  name: studioAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        // Generation streams for minutes; do not let idle SSE frames drop.
        stickySessions: {
          affinity: 'sticky'
        }
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'studio'
          image: studioImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: openAi.properties.endpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: openAiDeployment
            }
            {
              name: 'AZURE_OPENAI_FALLBACK_DEPLOYMENT'
              value: openAiFallbackDeployment
            }
            {
              name: 'AZURE_OPENAI_REASONING_EFFORT'
              value: openAiReasoningEffort
            }
            {
              name: 'ACA_RENDER_POOL_ENDPOINT'
              value: renderPool.properties.poolManagementEndpoint
            }
            {
              name: 'ACA_SESSION_API_VERSION'
              value: '2025-02-02-preview'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: studioMinReplicas
        maxReplicas: studioMaxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    acrPull
    sessionExecutor
  ]
}

// ------------------------------------------------------- azure openai access

// Grant the identity data-plane access on the pre-existing Azure OpenAI
// account. Scoped to that single account, never subscription-wide.
resource openAi 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: last(split(openAiAccountId, '/'))
  scope: resourceGroup(split(openAiAccountId, '/')[2], split(openAiAccountId, '/')[4])
}

module openAiAccess 'modules/openai-role.bicep' = {
  name: 'openai-role-assignment'
  scope: resourceGroup(split(openAiAccountId, '/')[2], split(openAiAccountId, '/')[4])
  params: {
    accountName: last(split(openAiAccountId, '/'))
    principalId: identity.properties.principalId
    roleDefinitionId: openAiUserRoleId
  }
}

// ------------------------------------------------------------------- outputs

@description('Public URL of the studio. Open this in a browser.')
output studioUrl string = 'https://${studio.properties.configuration.ingress.fqdn}'

@description('Login server for the container registry, for docker/az acr build.')
output registryLoginServer string = registry.properties.loginServer

@description('Registry name, for az acr build --registry.')
output registryName string = registry.name

@description('Image reference the studio Container App expects.')
output studioImage string = studioImage

@description('Image reference the render session pool expects.')
output renderImage string = renderImage

@description('Data-plane endpoint of the render session pool.')
output renderPoolEndpoint string = renderPool.properties.poolManagementEndpoint

@description('Client ID of the shared user-assigned managed identity.')
output identityClientId string = identity.properties.clientId

@description('Principal (object) ID of the shared user-assigned managed identity.')
output identityPrincipalId string = identity.properties.principalId
