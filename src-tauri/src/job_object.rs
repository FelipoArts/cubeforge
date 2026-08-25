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
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

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
}

#[cfg(not(windows))]
mod imp {
    pub fn track_process(_pid: u32) {}
}

pub use imp::track_process;
