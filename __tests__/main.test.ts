/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, you can create fixtures that export mock
 * functions and objects. For example, the core module is mocked in this test,
 * so that the actual '@actions/core' module is not imported.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

// Utility to create a minimal mock Response
function createMockResponse(options: {
  ok: boolean
  status?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: () => Promise<any>
  text?: () => Promise<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any
}): Response {
  const { ok, status = 200, json, text, body } = options

  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    body,
    bodyUsed: false,
    type: 'basic',
    url: '',
    redirected: false,
    json: json || (() => Promise.resolve({})),
    text: text || (() => Promise.resolve('')),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    clone: () => createMockResponse(options)
  } as unknown as Response
}

// Global fetch mock
const fetchMock = jest.fn<typeof fetch>()
global.fetch = fetchMock

// Mock for ReadableStream and TextDecoder
class MockReadableStreamDefaultReader {
  private events: Array<{ done: boolean; value: Uint8Array }> = []
  private currentEventIndex = 0

  setEvents(events: Array<{ done: boolean; value: Uint8Array }>): void {
    this.events = events
    this.currentEventIndex = 0
  }

  async read(): Promise<{ done: boolean; value: Uint8Array }> {
    if (this.currentEventIndex >= this.events.length) {
      return { done: true, value: new Uint8Array() }
    }
    return this.events[this.currentEventIndex++]
  }
}

const mockReader = new MockReadableStreamDefaultReader()

const mockBody = {
  getReader: () => mockReader
}

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { run } = await import('../src/main.js')

describe('main.ts', () => {
  const mockApiKey = 'test-api-key'
  const mockOriginUrl = 'https://test-origin.com'
  const mockRunId = 'test-run-id'

  beforeEach(() => {
    // Reset all mocks
    jest.resetAllMocks()

    // Set up input mocks
    core.getInput.mockImplementation((name) => {
      if (name === 'apiKey') return mockApiKey
      if (name === 'originUrl') return mockOriginUrl
      if (name === 'suiteIds') return 'suite1,suite2'
      if (name === 'failFast') return 'false'
      if (name === 'block') return 'false'
      return ''
    })

    // Set up fetch mock for successful response
    fetchMock.mockImplementation(async (url) => {
      if (url === `${mockOriginUrl}/external/actions/trigger`) {
        return createMockResponse({
          ok: true,
          json: async () => ({ run_id: mockRunId })
        })
      } else if (
        url === `${mockOriginUrl}/external/actions/run/${mockRunId}/events`
      ) {
        // Set up events for the reader
        const encoder = new TextEncoder()
        mockReader.setEvents([
          {
            done: false,
            value: encoder.encode(
              'event: test_suite_run.event\ndata: {"text": "All tests completed", "status": "passed"}\n\n'
            )
          },
          { done: true, value: new Uint8Array() }
        ])

        return createMockResponse({
          ok: true,
          body: mockBody
        })
      }

      return createMockResponse({
        ok: false,
        status: 404,
        text: async () => 'Not found'
      })
    })
  })

  it('Should trigger a test run and process SSE events', async () => {
    await run()

    // Verify API call to trigger endpoint
    expect(fetchMock).toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/trigger`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Api-Key': mockApiKey
        }),
        body: expect.stringContaining('suite_ids')
      })
    )

    // Verify SSE connection was made
    expect(fetchMock).toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/run/${mockRunId}/events`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Api-Key': mockApiKey
        })
      })
    )

    // Verify outputs were set
    expect(core.setOutput).toHaveBeenCalledWith('runId', mockRunId)
    expect(core.setOutput).toHaveBeenCalledWith('status', 'passed')
  })

  it('Should handle API trigger failure', async () => {
    // Mock a failed API call
    fetchMock.mockReset().mockImplementation(async () => {
      return createMockResponse({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      })
    })

    await run()

    // Verify error handling
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to trigger action: 401')
    )
  })

  it('Should handle SSE connection failure', async () => {
    // First call succeeds (trigger), second fails (SSE)
    fetchMock
      .mockReset()
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: true,
          json: async () => ({ run_id: mockRunId })
        })
      })
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: false,
          status: 500,
          text: async () => 'Server error'
        })
      })

    await run()

    // Verify error handling for SSE connection
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('SSE connection error')
    )
  })

  it('Should handle failed test status', async () => {
    fetchMock
      .mockReset()
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: true,
          json: async () => ({ run_id: mockRunId })
        })
      })
      .mockImplementationOnce(async () => {
        // Set up events for the reader with a failed status
        const encoder = new TextEncoder()
        mockReader.setEvents([
          {
            done: false,
            value: encoder.encode(
              'event: test_suite_run.event\ndata: {"text": "Test started", "status": "running"}\n\n'
            )
          },
          {
            done: false,
            value: encoder.encode(
              'event: test_suite_run.event\ndata: {"text": "Test failed", "status": "failed"}\n\n'
            )
          },
          { done: true, value: new Uint8Array() }
        ])

        return createMockResponse({
          ok: true,
          body: mockBody
        })
      })

    await run()

    // Verify the failed status is set
    expect(core.setOutput).toHaveBeenCalledWith('status', 'failed')
    expect(core.setFailed).toHaveBeenCalledWith('Test suite execution failed')
  })
})
