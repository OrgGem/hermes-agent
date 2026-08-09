import { Worker } from 'node:worker_threads'

import type { OpenAiEncoding } from './tokenizer-contract'

interface WorkerResponse {
  count?: number
  error?: string
  id: number
}

interface PendingRequest {
  reject: (error: Error) => void
  resolve: (count: number) => void
}

export interface TokenizerWorkerClientOptions {
  workerUrl?: URL
}

export class TokenizerWorkerClient {
  private nextId = 1
  private worker: Worker | null = null
  private readonly pending = new Map<number, PendingRequest>()

  constructor(private readonly options: TokenizerWorkerClientOptions = {}) {}

  count(text: string, encoding: OpenAiEncoding): Promise<number> {
    const worker = this.ensureWorker()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve })
      worker.postMessage({ encoding, id, text })
    })
  }

  async close(): Promise<void> {
    const worker = this.worker

    this.worker = null

    if (!worker) {
      return
    }

    const error = new Error('Service X tokenizer worker stopped.')

    for (const pending of this.pending.values()) {
      pending.reject(error)
    }

    this.pending.clear()
    await worker.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker
    }

    const workerUrl = this.options.workerUrl ?? new URL('./service-x-tokenizer-worker.mjs', import.meta.url)
    // The `.mjs` output is ESM; Node infers the module format from the URL.
    const worker = new Worker(workerUrl)

    worker.on('message', (response: WorkerResponse) => {
      const pending = this.pending.get(response.id)

      if (!pending) {
        return
      }

      this.pending.delete(response.id)

      if (response.error) {
        pending.reject(new Error(response.error))
      } else if (typeof response.count === 'number') {
        pending.resolve(response.count)
      } else {
        pending.reject(new Error('Service X tokenizer worker returned an invalid response.'))
      }
    })

    worker.on('error', error => {
      if (this.worker !== worker) {
        return
      }

      this.worker = null

      for (const pending of this.pending.values()) {
        pending.reject(error)
      }

      this.pending.clear()
    })

    worker.on('exit', code => {
      if (this.worker === worker) {
        this.worker = null
      }

      if (code !== 0) {
        const error = new Error(`Service X tokenizer worker exited with code ${code}.`)

        for (const pending of this.pending.values()) {
          pending.reject(error)
        }

        this.pending.clear()
      }
    })

    this.worker = worker

    return worker
  }
}
