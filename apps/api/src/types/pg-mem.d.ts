declare module 'pg-mem' {
  export const DataType: Record<string, string>;

  interface IMemoryDb {
    adapters: {
      createPg: () => {
        Pool: new () => import('pg').Pool;
        Client: new () => import('pg').Client;
      };
    };
    public: {
      registerFunction: (opts: {
        name: string;
        returns: string;
        implementation: (...args: unknown[]) => unknown;
        impure?: boolean;
      }) => void;
    };
  }

  export function newDb(): IMemoryDb;
}
