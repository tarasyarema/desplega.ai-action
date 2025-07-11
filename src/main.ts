import * as core from '@actions/core'

/**
 * Parse a comma-separated string into an array of strings
 * @param input The input string
 * @returns Array of strings
 */
function parseStringArray(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
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
 * Parse a string number to a number
 * @param input The input string
 * @returns Number value
 */
function parseNumber(input: string): number {
  const num = parseInt(input, 10)
  return isNaN(num) ? 0 : num
}

/**
 * Wait for a specified number of milliseconds
 * @param ms Milliseconds to wait
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param maxRetries Maximum number of retries (0 means no retries)
 * @param retryableErrorCheck Function to check if error should trigger retry
 * @returns Promise that resolves with the function result
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  retryableErrorCheck: (error: unknown) => boolean
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt === maxRetries || !retryableErrorCheck(error)) {
        throw error
      }

      // Calculate delay: 1s, 2s, 4s for attempts 1, 2, 3
      const delay = Math.pow(2, attempt) * 1000
      core.info(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`)
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Create an SSE client for real-time event streaming
 * @param url The SSE endpoint URL
 * @param headers Optional headers
 */
async function connectToSSE(
  url: string,
  headers: Record<string, string>
): Promise<void> {
  try {
    const abortController = new AbortController()

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: abortController.signal
    })

    if (!response.ok || !response.body) {
      throw new Error(`Failed to connect to SSE endpoint: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete events in the buffer
        const lines = buffer.split('\n\n')

        // Assume no partial events (should not happen)
        buffer = ''

        for (const line of lines) {
          if (!line.trim()) continue

          // Extract the event data
          const eventData = line
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.substring(5)
            .trim()

          const eventType = line
            .split('\n')
            .find((line) => line.startsWith('event:'))
            ?.substring(6)
            .trim()

          core.debug(`Event type: ${eventType}`)
          core.debug(`Event data: ${eventData}`)

          /*
           *  Example event data:
           *
           *  id: 22048943-4045-44dc-8b7c-2f41c8e637d6
           *  event: test_suite_run.event
           *  data: {"status": "passed", "elapsed": 4.678537, "end_time": "2025-05-21T21:45:37.774642+00:00", "test_ids": ["7eb44e14-6758-4180-9f87-81b42f54ff70", "5e220e7b-feb6-42fa-b3a5-ee5a12b5d50e"], "start_time": "2025-05-21T21:45:33.096100+00:00", "test_suite_id": "9acb9753-a6ca-4f4e-ba33-952f23978c9d", "ts": "2025-05-21T21:45:37.774642"}
           *
           */

          if (eventData) {
            try {
              const event = JSON.parse(eventData)
              core.info(`Event received: ${JSON.stringify(event)}`)

              const ts = event.ts ? new Date(event.ts).toISOString() : '-'
              const status = event.status
              const elapsed = event.elapsed ? `(${event.elapsed} seconds)` : '-'

              core.info(`${eventType} at ${ts}: ${status} ${elapsed}`)

              if (eventType !== 'test_suite_run.event') {
                continue
              }

              // Check if the run has completed
              if (['passed', 'failed', 'error'].includes(event.status)) {
                core.setOutput('status', event.status)

                if (event.status !== 'passed') {
                  core.setFailed('Test suite execution failed')
                }

                return
              }
            } catch {
              core.warning(`Failed to parse event data: ${eventData}`)
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        console.debug('SSE reader aborted')
      } else {
        throw e
      }
    } finally {
      reader.releaseLock()
      abortController.abort()
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
    const maxRetries = parseNumber(core.getInput('maxRetries'))

    // Parse suiteIds if provided
    const suiteIds = parseStringArray(suiteIdsInput)

    // Debug logs
    core.debug('Inputs:')
    core.debug(`- originUrl: ${originUrl}`)
    core.debug(`- suiteIds: ${suiteIds ? suiteIds.join(', ') : 'not provided'}`)
    core.debug(`- failFast: ${failFast}`)
    core.debug(`- block: ${block}`)
    core.debug(`- maxRetries: ${maxRetries}`)

    // Prepare request body
    const body: Record<string, unknown> = {}
    if (suiteIds) body.suite_ids = suiteIds
    body.fail_fast = failFast

    // Not implemented yet
    // body.block = block

    try {
      const versionUrl = `${originUrl}/version`
      const versionResp = await fetch(versionUrl)

      const version =
        ((await versionResp.json()) as Record<string, string>)?.version ??
        'unknown'
      core.info(`Using API version: ${version}`)
      core.setOutput('version', version)
    } catch (error) {
      core.warning(
        `Failed to parse version response: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }

    // Trigger the action
    core.info('Triggering test suite execution...')
    core.debug(`Request body: ${JSON.stringify(body)}`)

    const triggerUrl = `${originUrl}/external/actions/trigger`

    // Function to check if an error should trigger a retry
    const shouldRetry = (error: unknown): boolean => {
      if (error instanceof Error) {
        // Check if it's a fetch error (network issues)
        if (error.message.includes('fetch')) {
          return true
        }

        // Check if error message contains HTTP status indicating server error (5xx)
        const statusMatch = error.message.match(
          /Failed to trigger action: (\d+)/
        )
        if (statusMatch) {
          const status = parseInt(statusMatch[1], 10)
          return status >= 500 && status < 600
        }
      }
      return false
    }

    // Trigger function that can be retried
    const triggerAction = async (): Promise<{ run_id: string }> => {
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
        throw new Error(
          `Failed to trigger action: ${triggerResponse.status} ${errorText}`
        )
      }

      return (await triggerResponse.json()) as { run_id: string }
    }

    // Execute with retry logic if maxRetries > 0
    const triggerData =
      maxRetries > 0
        ? await retryWithBackoff(triggerAction, maxRetries, shouldRetry)
        : await triggerAction()
    const runId = triggerData.run_id

    if (!runId) {
      throw new Error('No run ID received from the trigger endpoint')
    }

    core.info(`Run ID: ${runId}`)
    core.setOutput('runId', runId)

    // Connect to SSE for real-time events
    const sseUrl = `${originUrl}/external/actions/run/${runId}/events`
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
