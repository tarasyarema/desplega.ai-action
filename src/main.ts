import * as core from '@actions/core'

/**
 * Parse a comma-separated string into an array of strings
 * @param input The input string
 * @returns Array of strings
 */
function parseStringArray(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  return input.split(',').map(item => item.trim()).filter(Boolean)
}

/**
 * Parse a string boolean to a boolean
 * @param input The input string
 * @returns Boolean value
 */
function parseBoolean(input: string): boolean {
  return input.toLowerCase() === 'true'
}

/**
 * Create an SSE client for real-time event streaming
 * @param url The SSE endpoint URL
 * @param headers Optional headers
 */
async function connectToSSE(url: string, headers: Record<string, string>): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers
    })

    if (!response.ok || !response.body) {
      throw new Error(`Failed to connect to SSE endpoint: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      
      // Process complete events in the buffer
      const lines = buffer.split('\n\n')
      buffer = lines.pop() || '' // Keep the last incomplete event in the buffer

      for (const line of lines) {
        if (!line.trim()) continue

        // Extract the event data
        const eventData = line.split('\n')
          .find(line => line.startsWith('data:'))
          ?.substring(5)
          .trim()

        if (eventData) {
          try {
            const event = JSON.parse(eventData)
            core.info(`Event received: ${event.text || JSON.stringify(event)}`)
            
            // Check if the run has completed
            if (event.status === 'passed' || event.status === 'failed') {
              core.setOutput('status', event.status)
              if (event.status === 'failed') {
                core.setFailed('Test suite execution failed')
              }
              return
            }
          } catch (error) {
            core.warning(`Failed to parse event data: ${eventData}`)
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`SSE connection error: ${error.message}`)
    } else {
      core.setFailed('Unknown SSE connection error')
    }
  }
}

/**
 * The main function for the action.
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get inputs
    const apiKey = core.getInput('apiKey', { required: true })
    const originUrl = core.getInput('originUrl')
    const suiteIdsInput = core.getInput('suiteIds')
    const failFast = parseBoolean(core.getInput('failFast'))
    const block = parseBoolean(core.getInput('block'))

    // Parse suiteIds if provided
    const suiteIds = parseStringArray(suiteIdsInput)

    // Debug logs
    core.debug('Inputs:')
    core.debug(`- originUrl: ${originUrl}`)
    core.debug(`- suiteIds: ${suiteIds ? suiteIds.join(', ') : 'not provided'}`)
    core.debug(`- failFast: ${failFast}`)
    core.debug(`- block: ${block}`)

    // Prepare request body
    const body: Record<string, unknown> = {}
    if (suiteIds) body.suiteIds = suiteIds
    body.failFast = failFast
    body.block = block

    // Trigger the action
    core.info('Triggering test suite execution...')
    const triggerUrl = `${originUrl}/actions/trigger`
    const triggerResponse = await fetch(triggerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(body)
    })

    if (!triggerResponse.ok) {
      const errorText = await triggerResponse.text()
      throw new Error(`Failed to trigger action: ${triggerResponse.status} ${errorText}`)
    }

    const triggerData = await triggerResponse.json() as { id: string }
    const runId = triggerData.id
    
    if (!runId) {
      throw new Error('No run ID received from the trigger endpoint')
    }

    core.info(`Run ID: ${runId}`)
    core.setOutput('runId', runId)

    // Connect to SSE for real-time events
    const sseUrl = `${originUrl}/actions/run/${runId}/events`
    core.info(`Connecting to SSE endpoint: ${sseUrl}`)
    
    await connectToSSE(sseUrl, {
      'X-Api-Key': apiKey
    })
    
    core.info('Test suite execution completed')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed('An unknown error occurred')
  }
}
