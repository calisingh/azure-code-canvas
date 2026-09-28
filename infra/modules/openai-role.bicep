// Grants a principal a data-plane role on an Azure OpenAI account that may
// live in a different resource group than the rest of the stack.
targetScope = 'resourceGroup'

@description('Name of the existing Cognitive Services / Azure OpenAI account.')
param accountName string

@description('Object ID of the principal receiving the role.')
param principalId string

@description('Built-in role definition GUID to assign.')
param roleDefinitionId string

resource account 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: accountName
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, principalId, roleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output accountEndpoint string = account.properties.endpoint
