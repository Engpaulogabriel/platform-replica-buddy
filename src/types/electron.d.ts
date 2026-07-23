export {};

declare global {
  interface Window {
    electronAPI?: { platform: string; isElectron: boolean };
    serialAPI?: {
      list: () => Promise<Array<{
        path: string;
        manufacturer?: string;
        serialNumber?: string;
        vendorId?: string;
        productId?: string;
        friendlyName?: string;
      }>>;
      open: (config: {
        path: string;
        baudRate: number | string;
        dataBits?: number | string;
        parity?: "none" | "even" | "odd" | "mark" | "space";
        stopBits?: number | string;
      }) => Promise<boolean>;
      close: () => Promise<boolean>;
      write: (data: string) => Promise<boolean>;
      isOpen: () => boolean;
      health: () => { serialAvailable: boolean; serialLoadError?: string };
      onData: (cb: (line: string) => void) => () => void;
      onStatus: (cb: (evt: { type: string; message?: string; path?: string }) => void) => () => void;
    };
    licenseAPI?: {
      getMachineId: () => string;
      activate: (licenseKey: string) => { success: boolean; machineId: string };
      checkLicense: () => { activated: boolean; machineId: string; activatedAt?: string };
      generateKey: (machineId: string) => string;
    };
  }
}
