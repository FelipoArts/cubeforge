// Job Object do Windows: garante que os processos filhos (java.exe do servidor
// Minecraft, sidecar tsnet-node) morram junto se o processo principal do Cubicase
// morrer — seja por fechamento normal, seja por ser finalizado à força pelo
// Gerenciador de Tarefas. Sem isso, finalizar o processo do app pelo Gerenciador
// de Tarefas deixaria esses filhos órfãos rodando escondidos em segundo plano.
//
// Non-Windows builds recebem um `track_process` no-op logo abaixo, então quem
// chama esta função não precisa se preocupar com cfg(windows) espalhado pelo resto
// do código.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // HANDLE (*mut c_void) não é Send/Sync por padrão; o valor é opaco e só usado
    // via chamadas de API do Windows, então é seguro compartilhar entre threads aqui.
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    fn get_or_create_job() -> HANDLE {
        JOB
            .get_or_init(|| unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !handle.is_null() {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const core::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                }
                JobHandle(handle)
            })
            .0
    }

    /// Atribui um processo (pelo PID) ao job object global. Best-effort: qualquer
    /// falha (processo já encerrado, permissão negada) é silenciosamente ignorada,
    /// já que isso é uma rede de segurança e não deve impedir o funcionamento normal.
    pub fn track_process(pid: u32) {
        unsafe {
            let job = get_or_create_job();
            if job.is_null() {
                return;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return;
            }
            AssignProcessToJobObject(job, process);
            CloseHandle(process);
        }
    }

    /// PIDs de processos cujo pai é `parent_pid`, via Toolhelp (não requer
    /// nenhum handle guardado de antemão — funciona mesmo sem ter criado o
    /// processo filho diretamente, olhando o PPID de todo processo do sistema).
    unsafe fn child_pids_of(parent_pid: u32) -> Vec<u32> {
        let mut result = Vec::new();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return result;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == parent_pid {
                    result.push(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        result
    }

    /// Mata um processo e, recursivamente, todos os processos filhos dele.
    ///
    /// Por quê: o servidor Minecraft roda dentro de um `cmd.exe` (ver
    /// start_minecraft_server em lib.rs — precisa do cmd.exe pra rodar
    /// "chcp 65001" antes do Java, corrigindo acentos/caracteres especiais
    /// que ficam ilegíveis sob um pseudo-terminal sem isso). Matar só o
    /// `cmd.exe` (via child.kill()) não mata o `java.exe` que ele iniciou —
    /// no Windows, matar um processo não mata os filhos dele por padrão.
    /// `track_process` (job object com KILL_ON_JOB_CLOSE) cobre "o app
    /// inteiro fechou", mas esse limite só dispara quando o HANDLE do job é
    /// fechado, não quando um membro específico é morto — e o job é
    /// compartilhado com o sidecar de rede, então não dá pra usar
    /// TerminateJobObject aqui sem derrubar ele junto. Best-effort: qualquer
    /// falha é ignorada, mesmo raciocínio de track_process.
    pub fn kill_process_tree(pid: u32) {
        unsafe {
            for child_pid in child_pids_of(pid) {
                kill_process_tree(child_pid);
            }
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn track_process(_pid: u32) {}
    pub fn kill_process_tree(_pid: u32) {}
}

pub use imp::{kill_process_tree, track_process};
