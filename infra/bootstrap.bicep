// ===========================================================================
// Bootstrap pass — the resources that must exist before any container image
// can be built and pushed.
//
// Split out from main.bicep because the Container App and the session pool
// both reference images by digest-resolvable tag at deployment time, so the
// registry has to be populated first.
// ===========================================================================

targetScope = 'resourceGroup'

@description('Short name used to derive every resource name.')
@minLength(3)
@maxLength(12)
param appName string = 'codecanvas'

@description('Azure region for all resources.')
param location string = resourceGroup().location

var suffix = uniqueString(resourceGroup().id)
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${appName}acr${suffix}'
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

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output identityId string = identity.id
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
