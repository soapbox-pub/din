/** Messages between the Calculator and its giac worker. */

export interface EvalResult {
  /** Giac's printed form of the result. */
  exact?: string;
  /** Its decimal value, when the result is an exact number. */
  decimal?: string;
  /** Giac's type name for the result (integer, rational, vector, ...). */
  type?: string;
  error?: string;
  /** Warnings worth showing (e.g. an integral giac couldn't check). */
  messages: string[];
}

export type WorkerRequest =
  | { id: number; type: 'eval'; code: string; store: string; approx: boolean; simplify: boolean }
  | { id: number; type: 'run'; codes: string[] }
  | { id: number; type: 'sample'; expr: string; variable: string; xs: number[] };

export type WorkerResponse =
  | { type: 'ready' }
  | { id: number; type: 'eval'; result: EvalResult }
  | { id: number; type: 'run'; results: ({ out: string } | { error: string })[] }
  | { id: number; type: 'sample'; values: number[] };
