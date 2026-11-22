/**
 * The parts of WebHID (https://wicg.github.io/webhid/) the gamepad adapter uses. TypeScript's DOM
 * library doesn't declare WebHID, so these are local structural types: a real `navigator.hid` and
 * its `HIDDevice`s satisfy them, and so does any object shaped the same way.
 */

export interface HidReportItem {
  readonly reportSize?: number;
  readonly reportCount?: number;
}

export interface HidReportInfo {
  readonly reportId?: number;
  readonly items?: readonly HidReportItem[];
}

export interface HidCollectionInfo {
  readonly usagePage?: number;
  readonly usage?: number;
  readonly inputReports?: readonly HidReportInfo[];
  readonly outputReports?: readonly HidReportInfo[];
  readonly featureReports?: readonly HidReportInfo[];
}

export interface HidInputReportEvent {
  readonly device: HidDevice;
  readonly reportId: number;
  /** The report's bytes after its report id. */
  readonly data: DataView;
}

export interface HidDevice {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HidCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  /** `data` is the report's bytes after its id. */
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: "inputreport", listener: (e: HidInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (e: HidInputReportEvent) => void): void;
}

export interface HidDeviceFilter {
  readonly vendorId?: number;
  readonly productId?: number;
  readonly usagePage?: number;
  readonly usage?: number;
}

export interface HidConnectionEvent {
  readonly device: HidDevice;
}

export interface Hid {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: HidDeviceFilter[] }): Promise<HidDevice[]>;
  addEventListener(type: "connect" | "disconnect", listener: (e: HidConnectionEvent) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (e: HidConnectionEvent) => void): void;
}
