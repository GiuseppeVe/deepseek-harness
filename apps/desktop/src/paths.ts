/** Mutable filesystem locations and fail-closed Windows DACL setup for DSH Desktop. */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

/** Every mutable path owned by one Windows user's DSH Desktop installation. */
export interface DesktopPaths {
  /** DSH home passed to the owned backend process. */
  home: string
  /** User-owned credentials file. */
  env: string
  /** Bounded backend-log directory. */
  logs: string
  /** Authenticated owned-backend lease. */
  lease: string
}

/** Injectable data-root operations. */
export interface DesktopPathAdapter {
  /** Create one directory and its missing parents. */
  mkdir(path: string): Promise<void>
  /** Reject reparse points and reset the existing root tree to the current SID. */
  hardenTree(path: string): Promise<void>
}

/** Injectable fixed PowerShell runner for Windows DACL application. */
export interface WindowsDesktopPathAdapterOptions {
  /** Create Desktop directories. */
  mkdir(path: string): Promise<void>
  /** Run one fixed executable without constructing a command string. */
  run(
    command: 'powershell.exe',
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<void>
}

/** Resolve Desktop's mutable files below the caller's LocalAppData directory. */
export function resolveDesktopPaths(localAppData: string): DesktopPaths {
  const home = `${localAppData.replace(/[\\/]+$/, '')}/DSH Desktop`
  return {
    home,
    env: `${home}/.env`,
    logs: `${home}/logs`,
    lease: `${home}/backend.lease.json`,
  }
}

/** Fixed PowerShell body; root travels only through its process environment value. */
const RESET_DESKTOP_DACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$root = [Environment]::GetEnvironmentVariable('DSH_DESKTOP_DATA_ROOT', 'Process')
if ([string]::IsNullOrWhiteSpace($root)) { throw 'DSH Desktop data root is missing' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
using System.Security.Principal;

public static class DshDesktopAcl {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileAttributeTagInfo {
    public FileAttributes FileAttributes;
    public uint ReparseTag;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatusBlock {
    public IntPtr Status;
    public IntPtr Information;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string path,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle file,
    int informationClass,
    out FileAttributeTagInfo information,
    uint size);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(
    SafeFileHandle handle,
    int objectType,
    uint securityInformation,
    IntPtr owner,
    IntPtr group,
    IntPtr dacl,
    IntPtr sacl);

  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out SafeFileHandle file,
    uint desiredAccess,
    ref ObjectAttributes objectAttributes,
    out IoStatusBlock ioStatus,
    IntPtr allocationSize,
    uint fileAttributes,
    uint shareAccess,
    uint createDisposition,
    uint createOptions,
    IntPtr eaBuffer,
    uint eaLength);

  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(
    SafeFileHandle file,
    IntPtr eventHandle,
    IntPtr apcRoutine,
    IntPtr apcContext,
    out IoStatusBlock ioStatus,
    IntPtr fileInformation,
    uint length,
    int fileInformationClass,
    bool returnSingleEntry,
    IntPtr fileName,
    bool restartScan);

  public static void HardenTree(string root, SecurityIdentifier sid) {
    const uint ReadControl = 0x00020000;
    const uint WriteDac = 0x00040000;
    const uint FileReadAttributes = 0x00000080;
    const uint FileListDirectory = 0x00000001;
    const uint OpenExisting = 3;
    const uint FileFlagBackupSemantics = 0x02000000;
    const uint FileFlagOpenReparsePoint = 0x00200000;
    using (SafeFileHandle rootHandle = CreateFile(
      root,
      ReadControl | WriteDac | FileReadAttributes | FileListDirectory,
      0,
      IntPtr.Zero,
      OpenExisting,
      FileFlagBackupSemantics | FileFlagOpenReparsePoint,
      IntPtr.Zero)) {
      if (rootHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot open Desktop data root");
      if (!HardenHandle(rootHandle, sid)) throw new InvalidOperationException("Desktop data root is not a directory");
      HardenDirectory(rootHandle, sid);
    }
  }

  private static bool HardenHandle(SafeFileHandle handle, SecurityIdentifier sid) {
    const int FileAttributeTagInfoClass = 9;
    const int SeFileObject = 1;
    const uint DaclSecurityInformation = 0x00000004;
    const uint ProtectedDaclSecurityInformation = 0x80000000;
    FileAttributeTagInfo information;
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfoClass, out information, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot inspect Desktop data item");
    }
    if ((information.FileAttributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Desktop data tree contains a reparse point");

    bool isDirectory = (information.FileAttributes & FileAttributes.Directory) != 0;
    RawAcl acl = new RawAcl(2, 1);
    AceFlags flags = isDirectory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None;
    acl.InsertAce(0, new CommonAce(flags, AceQualifier.AccessAllowed, (int)FileSystemRights.FullControl, sid, false, null));
    byte[] bytes = new byte[acl.BinaryLength];
    acl.GetBinaryForm(bytes, 0);
    IntPtr dacl = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, dacl, bytes.Length);
      uint error = SetSecurityInfo(handle, SeFileObject, DaclSecurityInformation | ProtectedDaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (error != 0) throw new Win32Exception((int)error, "cannot set Desktop data item DACL");
    } finally {
      Marshal.FreeHGlobal(dacl);
    }
    return isDirectory;
  }

  private static void HardenDirectory(SafeFileHandle directory, SecurityIdentifier sid) {
    const int FileNamesInformation = 12;
    const int NoMoreFiles = unchecked((int)0x80000006);
    const uint ReadControl = 0x00020000;
    const uint WriteDac = 0x00040000;
    const uint FileReadAttributes = 0x00000080;
    const uint FileListDirectory = 0x00000001;
    const uint Synchronize = 0x00100000;
    const uint FileOpen = 1;
    const uint FileOpenReparsePoint = 0x00200000;
    const uint FileSynchronousIoNonalert = 0x00000020;
    const uint FileOpenForBackupIntent = 0x00004000;
    const uint ObjectCaseInsensitive = 0x00000040;
    const int FileNameOffset = 12;
    const int BufferSize = 4096;
    bool restartScan = true;
    IntPtr buffer = Marshal.AllocHGlobal(BufferSize);
    try {
      while (true) {
        IoStatusBlock ioStatus;
        int status = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out ioStatus, buffer, BufferSize, FileNamesInformation, true, IntPtr.Zero, restartScan);
        restartScan = false;
        if (status == NoMoreFiles) return;
        if (status != 0) throw new InvalidOperationException("cannot enumerate Desktop data directory: " + status.ToString());
        int nameLength = Marshal.ReadInt32(buffer, 8);
        string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, FileNameOffset), nameLength / 2);
        if (name == "." || name == "..") continue;
        using (SafeFileHandle child = OpenChild(directory, name, ReadControl | WriteDac | FileReadAttributes | FileListDirectory | Synchronize, FileOpenReparsePoint | FileSynchronousIoNonalert | FileOpenForBackupIntent, FileOpen, ObjectCaseInsensitive)) {
          if (HardenHandle(child, sid)) HardenDirectory(child, sid);
        }
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private static SafeFileHandle OpenChild(SafeFileHandle parent, string name, uint desiredAccess, uint createOptions, uint createDisposition, uint attributes) {
    if (name.IndexOfAny(new[] { (char)92, '/', (char)0 }) >= 0) throw new InvalidOperationException("Desktop data directory entry is invalid");
    IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
    IntPtr unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
    try {
      UnicodeString unicode = new UnicodeString { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)((name.Length + 1) * 2)), Buffer = nameBuffer };
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      ObjectAttributes objectAttributes = new ObjectAttributes {
        Length = Marshal.SizeOf(typeof(ObjectAttributes)),
        RootDirectory = parent.DangerousGetHandle(),
        ObjectName = unicodePointer,
        Attributes = attributes,
      };
      IoStatusBlock ioStatus;
      SafeFileHandle child;
      int status = NtCreateFile(out child, desiredAccess, ref objectAttributes, out ioStatus, IntPtr.Zero, 0, 0, createDisposition, createOptions, IntPtr.Zero, 0);
      if (status != 0 || child.IsInvalid) throw new InvalidOperationException("cannot open Desktop data child");
      return child;
    } finally {
      Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(nameBuffer);
    }
  }
}
'@
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
[DshDesktopAcl]::HardenTree($root, $sid)
`

/** Encode a static PowerShell program for noninteractive execution. */
function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Create Desktop's data root, secure its existing tree, then create mutable descendants. */
export async function prepareDesktopPaths(paths: DesktopPaths, adapter: DesktopPathAdapter): Promise<void> {
  await adapter.mkdir(paths.home)
  try {
    await adapter.hardenTree(paths.home)
  } catch (error) {
    throw new Error(`Desktop data ACL setup failed: ${error instanceof Error ? error.message : 'unknown failure'}`)
  }
  await adapter.mkdir(paths.logs)
  try {
    await adapter.hardenTree(paths.home)
  } catch (error) {
    throw new Error(`Desktop data ACL setup failed: ${error instanceof Error ? error.message : 'unknown failure'}`)
  }
}

/** Create an adapter whose root stays out of PowerShell arguments and source text. */
export function createWindowsDesktopPathAdapter(options: WindowsDesktopPathAdapterOptions): DesktopPathAdapter {
  return {
    mkdir: options.mkdir,
    async hardenTree(path: string): Promise<void> {
      await options.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedPowerShell(RESET_DESKTOP_DACL_SCRIPT),
      ], { DSH_DESKTOP_DATA_ROOT: path })
    },
  }
}

/** Default directory creator for Electron's Windows-only main process. */
export const nodeDesktopPathAdapter: Pick<DesktopPathAdapter, 'mkdir'> = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
}

const execFileAsync = promisify(execFile)

/** Production Windows adapter that resets every existing data-tree DACL before descendant writes. */
export function createNodeWindowsDesktopPathAdapter(): DesktopPathAdapter {
  return createWindowsDesktopPathAdapter({
    ...nodeDesktopPathAdapter,
    run: async (command, args, env) => {
      await execFileAsync(command, [...args], { env: { ...process.env, ...env }, windowsHide: true })
    },
  })
}
