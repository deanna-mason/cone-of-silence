// This repo's lib.dom (TS >=5) already declares FileSystemHandle,
// FileSystemDirectoryHandle/FileSystemFileHandle, and
// createWritable/write/close/getFile. Two gaps remain, added here (checked
// with `npx tsc --noEmit` first): the Permissions-flavored members of the
// File System Access spec — queryPermission/requestPermission — and the
// window.showDirectoryPicker() entry point used to obtain the initial handle.
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    mode?: "read" | "readwrite";
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
