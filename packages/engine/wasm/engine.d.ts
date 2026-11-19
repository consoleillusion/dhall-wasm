export interface JsffiExports {
  newJSVal(value: unknown): number;
  getJSVal(id: number): unknown;
  freeJSVal(id: number): void;
  scheduleWork(): void;
  [name: string]: (...args: any[]) => unknown;
}

type JsffiFactory = (exports: Record<string, (...args: any[]) => unknown>) => JsffiExports;

const createJsffiImports: JsffiFactory;
export default createJsffiImports;
