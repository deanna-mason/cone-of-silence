// This repo's lib.dom (TS >=5) already declares FileSystemHandle,
// FileSystemDirectoryHandle/FileSystemFileHandle, and
// createWritable/write/close/getFile. Gaps remain, added here (checked with
// `npx tsc --noEmit` first): the Permissions-flavored members of the File
// System Access spec — queryPermission/requestPermission — the
// window.showDirectoryPicker() entry point used to obtain the initial
// handle, and (Phase 5B) FileSystemFileHandle.move() for episodeStore.ts's
// atomic temp-name renames. Directory async iteration WAS checked too:
// tsconfig's "dom.iterable" lib only pulls in lib.dom.iterable.d.ts (SYNC
// iterables — Map/Set/NodeList/etc.); the DOM's async directory iteration
// (keys()/values()/entries()) lives in lib.dom.asynciterable.d.ts, gated
// behind a separate "dom.asynciterable" lib entry this project doesn't
// enable — so `dir.keys()` genuinely needs declaring here too, unlike the
// other gaps which really were pre-covered.
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemFileHandle {
    move(newName: string): Promise<void>;
  }

  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
  }

  interface DirectoryPickerOptions {
    mode?: "read" | "readwrite";
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
