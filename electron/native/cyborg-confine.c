/*
 * cyborg-confine: запускатель хоста стороннего плагина на Linux (TR-22b, ADR-CH-0019, п. 6).
 *
 * Накладывает на себя и на всех потомков три слоя и запускает команду:
 *   1. no_new_privs: setuid-программа или файловые права не повысят привилегии (нужен и Landlock, и seccomp без root);
 *   2. Landlock (по версии ABI ядра): файлы - чтение только названных каталогов и файлов, записи нет вовсе, исполнение только названного;
 *      с ABI 4 (ядро 6.7) закрыты и TCP bind/connect, с ABI 6 (ядро 6.12) - абстрактные unix-сокеты и сигналы наружу домена;
 *   3. seccomp: сокеты не создаются вовсе (сеть, unix-сокеты по пути: D-Bus, docker.sock), нет fork/vfork/clone без CLONE_THREAD,
 *      нет ptrace, process_vm_*, io_uring, bpf, mount, setns/unshare и других вызовов, которыми выбираются из окружения.
 *
 * Ядра без Landlock (до 5.13 или с выключенным LSM) честно называются в ответе --probe, и запуск с --require-landlock отказывает.
 * Закрытые слои не откатываются: no_new_privs необратим, домен Landlock и фильтр seccomp наследуются потомками.
 *
 * Использование:
 *   cyborg-confine --probe                                     печатает JSON: abi Landlock, seccomp, архитектура, ядро; ничего не накладывает
 *   cyborg-confine [--read=ПУТЬ]... [--exec=ПУТЬ]... [--write=ПУТЬ]... [--require-landlock] [--no-seccomp] -- команда аргументы...
 *
 * Только libc и заголовки ядра; константы Landlock объявлены здесь, чтобы сборка не зависела от версии linux/landlock.h на машине сборки.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef SECCOMP_RET_ERRNO
#define SECCOMP_RET_ERRNO 0x00050000U
#endif

/* Landlock: номера вызовов едины для всех архитектур (общая таблица), значения - из uapi/linux/landlock.h. */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1
#define LL_ACCESS_FS_EXECUTE (1ULL << 0)
#define LL_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LL_ACCESS_FS_READ_FILE (1ULL << 2)
#define LL_ACCESS_FS_READ_DIR (1ULL << 3)
#define LL_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LL_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LL_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define LL_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define LL_ACCESS_FS_MAKE_REG (1ULL << 8)
#define LL_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define LL_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define LL_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LL_ACCESS_FS_MAKE_SYM (1ULL << 12)
#define LL_ACCESS_FS_REFER (1ULL << 13)    /* ABI 2 */
#define LL_ACCESS_FS_TRUNCATE (1ULL << 14) /* ABI 3 */
#define LL_ACCESS_FS_IOCTL_DEV (1ULL << 15) /* ABI 5 */
#define LL_ACCESS_NET_BIND_TCP (1ULL << 0) /* ABI 4 */
#define LL_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) /* ABI 6 */
#define LL_SCOPE_SIGNAL (1ULL << 1)

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};
struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

static int ll_abi(void) {
  long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  return v < 0 ? 0 : (int)v;
}

static const char *arch_name(void) {
#if defined(__x86_64__)
  return "x86_64";
#elif defined(__aarch64__)
  return "aarch64";
#else
  return "unsupported";
#endif
}

#if defined(__x86_64__)
#define CONFINE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define CONFINE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#endif

static int seccomp_available(void) {
  int r = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  return r >= 0 && arch_name()[0] != 'u';
}

static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') putchar('\\');
    if ((unsigned char)*s >= 0x20) putchar(*s);
  }
  putchar('"');
}

static int probe(void) {
  struct utsname u;
  uname(&u);
  printf("{\"abi\":%d,\"seccomp\":%s,\"arch\":", ll_abi(), seccomp_available() ? "true" : "false");
  json_string(arch_name());
  printf(",\"kernel\":");
  json_string(u.release);
  printf("}\n");
  return 0;
}

struct paths {
  const char *items[64];
  int n;
};

static int add_path(struct paths *p, const char *path) {
  if (p->n >= 64) return -1;
  p->items[p->n++] = path;
  return 0;
}

static int landlock_add(int ruleset, const char *path, uint64_t access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    /* Нет такого пути на этой машине (например, /lib64 на arm64): правило не нужно. */
    if (errno == ENOENT || errno == ENOTDIR) return 0;
    fprintf(stderr, "cyborg-confine: %s: %s\n", path, strerror(errno));
    return -1;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    return -1;
  }
  /* Для файла каталожные права недопустимы (EINVAL). */
  if (!S_ISDIR(st.st_mode)) access &= (LL_ACCESS_FS_EXECUTE | LL_ACCESS_FS_WRITE_FILE | LL_ACCESS_FS_READ_FILE | LL_ACCESS_FS_TRUNCATE | LL_ACCESS_FS_IOCTL_DEV);
  struct ll_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
  long r = syscall(__NR_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(fd);
  if (r != 0) {
    fprintf(stderr, "cyborg-confine: Landlock не принял %s: %s\n", path, strerror(saved));
    return -1;
  }
  return 0;
}

/* Возвращает 0 - Landlock наложен, 1 - ядро без Landlock (ничего не наложено), -1 - ошибка. */
static int apply_landlock(const struct paths *read, const struct paths *exec, const struct paths *write) {
  int abi = ll_abi();
  if (abi < 1) return 1;
  uint64_t fs = LL_ACCESS_FS_EXECUTE | LL_ACCESS_FS_WRITE_FILE | LL_ACCESS_FS_READ_FILE | LL_ACCESS_FS_READ_DIR | LL_ACCESS_FS_REMOVE_DIR | LL_ACCESS_FS_REMOVE_FILE |
                LL_ACCESS_FS_MAKE_CHAR | LL_ACCESS_FS_MAKE_DIR | LL_ACCESS_FS_MAKE_REG | LL_ACCESS_FS_MAKE_SOCK | LL_ACCESS_FS_MAKE_FIFO | LL_ACCESS_FS_MAKE_BLOCK | LL_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) fs |= LL_ACCESS_FS_REFER;
  if (abi >= 3) fs |= LL_ACCESS_FS_TRUNCATE;
  if (abi >= 5) fs |= LL_ACCESS_FS_IOCTL_DEV;
  struct ll_ruleset_attr attr = {.handled_access_fs = fs, .handled_access_net = abi >= 4 ? (LL_ACCESS_NET_BIND_TCP | LL_ACCESS_NET_CONNECT_TCP) : 0, .scoped = abi >= 6 ? (LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL) : 0};
  /* Размер структуры по версии ABI: ядро принимает прежний размер, а лишние нули в большем тоже, но точный размер надёжнее. */
  size_t size = abi >= 6 ? sizeof(attr) : abi >= 4 ? offsetof(struct ll_ruleset_attr, scoped) : offsetof(struct ll_ruleset_attr, handled_access_net);
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, size, 0);
  if (ruleset < 0) {
    fprintf(stderr, "cyborg-confine: Landlock: %s\n", strerror(errno));
    return -1;
  }
  for (int i = 0; i < read->n; i++)
    if (landlock_add(ruleset, read->items[i], LL_ACCESS_FS_READ_FILE | LL_ACCESS_FS_READ_DIR) != 0) return -1;
  for (int i = 0; i < exec->n; i++)
    if (landlock_add(ruleset, exec->items[i], LL_ACCESS_FS_EXECUTE | LL_ACCESS_FS_READ_FILE | LL_ACCESS_FS_READ_DIR) != 0) return -1;
  for (int i = 0; i < write->n; i++)
    if (landlock_add(ruleset, write->items[i], LL_ACCESS_FS_WRITE_FILE | LL_ACCESS_FS_READ_FILE) != 0) return -1;
  /* TCP: правил нет вовсе - bind и connect отказаны всем. */
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) {
    fprintf(stderr, "cyborg-confine: Landlock restrict_self: %s\n", strerror(errno));
    return -1;
  }
  close(ruleset);
  return 0;
}

/* seccomp: список запрещённого, остальное разрешено (Node без этого не запустится). */
#define LD_NR(nr) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))
#define DENY(sysno, err) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (sysno), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))

static int apply_seccomp(void) {
#ifndef CONFINE_AUDIT_ARCH
  fprintf(stderr, "cyborg-confine: seccomp на этой архитектуре не поддержан\n");
  return -1;
#else
  struct sock_filter filter[] = {
      /* Чужая архитектура (32-битный режим на x86_64) - отказ целиком: номера вызовов у неё другие. */
      LD_NR(arch),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CONFINE_AUDIT_ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      LD_NR(nr),
      /* Сеть и сокеты по пути (D-Bus, docker.sock): сокет не создаётся вовсе. socketpair остаётся - пара внутри процесса ничего не открывает. */
      DENY(__NR_socket, EPERM),
      DENY(__NR_ptrace, EPERM),
      DENY(__NR_process_vm_readv, EPERM),
      DENY(__NR_process_vm_writev, EPERM),
      DENY(__NR_io_uring_setup, EPERM),
      DENY(__NR_io_uring_enter, EPERM),
      DENY(__NR_io_uring_register, EPERM),
      DENY(__NR_bpf, EPERM),
      DENY(__NR_perf_event_open, EPERM),
      DENY(__NR_userfaultfd, EPERM),
      DENY(__NR_mount, EPERM),
      DENY(__NR_umount2, EPERM),
      DENY(__NR_pivot_root, EPERM),
      DENY(__NR_chroot, EPERM),
      DENY(__NR_setns, EPERM),
      DENY(__NR_unshare, EPERM),
      DENY(__NR_keyctl, EPERM),
      DENY(__NR_add_key, EPERM),
      DENY(__NR_request_key, EPERM),
      DENY(__NR_kexec_load, EPERM),
      DENY(__NR_init_module, EPERM),
      DENY(__NR_finit_module, EPERM),
      DENY(__NR_delete_module, EPERM),
#ifdef __NR_fork
      DENY(__NR_fork, EPERM),
#endif
#ifdef __NR_vfork
      DENY(__NR_vfork, EPERM),
#endif
      /* clone3 читает флаги из структуры в памяти, фильтр их не видит: ENOSYS заставляет glibc откатиться на clone, флаги которого видны. */
      DENY(__NR_clone3, ENOSYS),
      /* clone без CLONE_THREAD - это fork: потоки (libuv, V8) разрешены, процессы нет. */
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
      LD_NR(args[0]),
      BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {.len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0) != 0) {
    fprintf(stderr, "cyborg-confine: seccomp: %s\n", strerror(errno));
    return -1;
  }
  return 0;
#endif
}

int main(int argc, char **argv) {
  struct paths read = {.n = 0}, exec = {.n = 0}, write = {.n = 0};
  int require_landlock = 0, no_seccomp = 0, i = 1;
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return probe();
  for (; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "--") == 0) {
      i++;
      break;
    }
    if (strncmp(a, "--read=", 7) == 0) {
      if (add_path(&read, a + 7) != 0) return 2;
    } else if (strncmp(a, "--exec=", 7) == 0) {
      if (add_path(&exec, a + 7) != 0) return 2;
    } else if (strncmp(a, "--write=", 8) == 0) {
      if (add_path(&write, a + 8) != 0) return 2;
    } else if (strcmp(a, "--require-landlock") == 0) {
      require_landlock = 1;
    } else if (strcmp(a, "--no-seccomp") == 0) {
      no_seccomp = 1;
    } else {
      fprintf(stderr, "cyborg-confine: неизвестный аргумент %s\n", a);
      return 2;
    }
  }
  if (i >= argc) {
    fprintf(stderr, "cyborg-confine: после -- нужна команда\n");
    return 2;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "cyborg-confine: no_new_privs: %s\n", strerror(errno));
    return 3;
  }
  int landlock = apply_landlock(&read, &exec, &write);
  if (landlock < 0) return 3;
  if (landlock == 1 && require_landlock) {
    fprintf(stderr, "cyborg-confine: ядро без Landlock (ABI 0), а он требуется\n");
    return 4;
  }
  if (!no_seccomp && apply_seccomp() != 0) return 3;
  execvp(argv[i], &argv[i]);
  fprintf(stderr, "cyborg-confine: %s: %s\n", argv[i], strerror(errno));
  return 127;
}
