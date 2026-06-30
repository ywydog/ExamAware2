<template>
  <div class="settings-page">
    <h2>外部 IPC</h2>
    <t-space direction="vertical" size="small" style="width: 100%">
      <t-card :title="'内部 IPC'" theme="poster2">
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="laptop" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">内部通信</div>
            <div class="settings-item-desc">
              ExamAware2 窗口间通信（播放器 → 主进程），始终启用，无需配置。
            </div>
          </div>
          <div class="settings-item-action">
            <t-tag theme="success" variant="light-outline">始终启用</t-tag>
          </div>
        </div>
      </t-card>

      <t-card :title="'外部 IPC'" theme="poster2">
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="swap" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">启用外部 IPC</div>
            <div class="settings-item-desc">
              允许外部程序（如 ClassIsland 插件）通过 Named Pipe / Unix Socket 控制 ExamAware2
              的放映功能，并接收考试事件推送。
            </div>
          </div>
          <div class="settings-item-action">
            <t-switch
              v-model="externalIpcEnabled"
              :label="[
                { value: true, label: '开' },
                { value: false, label: '关' }
              ]"
            />
          </div>
        </div>

        <t-divider />

        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="server" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">IPC 地址</div>
            <div class="settings-item-desc">外部程序连接此管道/套接字进行通信。</div>
            <div style="margin-top: 4px; display: flex; align-items: center; gap: 8px">
              <t-tag v-if="externalIpcEnabled" theme="success" variant="light-outline">
                {{ ipcAddress }}
              </t-tag>
              <t-tag v-else theme="default" variant="light-outline">服务已关闭</t-tag>
              <t-button
                variant="outline"
                size="small"
                :disabled="!externalIpcEnabled"
                @click="copyIpcAddress"
              >
                复制地址
              </t-button>
            </div>
          </div>
        </div>

        <t-divider />

        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="link" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">连接状态</div>
            <div class="settings-item-desc">检查是否有外部程序（如 ClassIsland）已连接。</div>
            <div style="margin-top: 4px; display: flex; align-items: center; gap: 8px">
              <t-tag
                v-if="connectionStatus"
                :theme="connectionStatus.clientCount > 0 ? 'success' : 'warning'"
                variant="light-outline"
              >
                {{
                  connectionStatus.clientCount > 0
                    ? `${connectionStatus.clientCount} 个客户端已连接`
                    : '暂无客户端连接'
                }}
              </t-tag>
              <t-button
                variant="outline"
                size="small"
                :disabled="!externalIpcEnabled"
                :loading="checkingConnection"
                @click="checkConnection"
              >
                检查连接
              </t-button>
            </div>
            <div
              v-if="connectionStatus && connectionStatus.clientCount > 0"
              style="margin-top: 8px"
            >
              <div
                v-for="client in connectionStatus.clients"
                :key="client.id"
                style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px"
              >
                <t-tag variant="light-outline" size="small"> #{{ client.id }} </t-tag>
                <t-tag variant="light-outline" size="small">
                  {{ formatTime(client.connectedAt) }}
                </t-tag>
              </div>
            </div>
          </div>
        </div>

        <t-divider />

        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="control-platform" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">测试 IPC 通信</div>
            <div class="settings-item-desc">
              主动连接 IPC 端点并发送 <code>ping</code>，验证管道/套接字可连通。
            </div>
            <div
              style="margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap"
            >
              <t-button
                variant="outline"
                size="small"
                :disabled="!externalIpcEnabled"
                :loading="testingConnection"
                @click="testIpcConnection"
              >
                测试 IPC 通信
              </t-button>
              <t-tag
                v-if="testResult"
                :theme="testResult.success ? 'success' : 'danger'"
                variant="light-outline"
              >
                {{ testResult.success ? '连接成功' : '连接失败' }}
              </t-tag>
            </div>
            <div
              v-if="testResult && !testResult.success && testResult.error"
              style="
                margin-top: 6px;
                font-size: 12px;
                color: var(--td-text-color-secondary);
                word-break: break-all;
              "
            >
              {{ testResult.error }}
            </div>
            <div
              v-else-if="testResult && testResult.success"
              style="
                margin-top: 6px;
                font-size: 12px;
                color: var(--td-text-color-secondary);
                word-break: break-all;
              "
            >
              已与 {{ testResult.address }} 成功建立连接并完成 ping。
            </div>
          </div>
        </div>

        <t-divider />

        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="control-platform" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">支持的命令</div>
            <div class="settings-item-desc">外部程序可发送的 IPC 命令。</div>
            <div style="margin-top: 4px">
              <t-tag
                v-for="cmd in commands"
                :key="cmd"
                variant="light-outline"
                style="margin-right: 4px; margin-bottom: 4px"
              >
                {{ cmd }}
              </t-tag>
            </div>
          </div>
        </div>

        <t-divider />

        <t-alert
          v-if="externalIpcEnabled"
          theme="info"
          message="启用外部 IPC 后，同一台计算机上的其他程序可以控制 ExamAware2 的放映功能。请确保在可信环境中使用。"
          style="margin-top: 12px"
        />
      </t-card>
    </t-space>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { Icon as TIcon } from 'tdesign-icons-vue-next'

const settingsApi = inject('settingsApi') as {
  get: (key: string, def?: any) => any
  set: (key: string, value: any) => void
}

const ipcRenderer = inject('ipcRenderer') as any

const externalIpcEnabled = ref(settingsApi.get('externalIpc.enabled', true))
const checkingConnection = ref(false)
const testingConnection = ref(false)
const connectionStatus = ref<{ isRunning: boolean; clientCount: number; clients: any[] } | null>(
  null
)
const testResult = ref<{ success: boolean; error?: string; address: string } | null>(null)

const ipcAddress = computed(() => {
  if (typeof navigator === 'undefined') return ''
  return navigator.platform?.startsWith('Win')
    ? '\\\\.\\pipe\\ExamAware2.examaware2'
    : '/tmp/ExamAware2.examaware2.sock'
})

const commands = ['ping', 'subscribe-events', 'play-from-url', 'play-from-file', 'stop', 'status']

watch(externalIpcEnabled, (val) => {
  settingsApi.set('externalIpc.enabled', val)
  // 关闭时清除连接状态
  if (!val) {
    connectionStatus.value = null
    testResult.value = null
  }
})

async function checkConnection() {
  checkingConnection.value = true
  try {
    const status = await ipcRenderer.invoke('external-ipc:get-status')
    connectionStatus.value = status
    if (status.clientCount > 0) {
      MessagePlugin.success(`检测到 ${status.clientCount} 个外部客户端已连接`)
    } else {
      MessagePlugin.warning(
        '暂无外部客户端连接。请确保 ClassIsland 已安装 ExamAware2Ci 插件并已启动。'
      )
    }
  } catch (error) {
    MessagePlugin.error('获取连接状态失败')
    connectionStatus.value = null
  } finally {
    checkingConnection.value = false
  }
}

async function testIpcConnection() {
  testingConnection.value = true
  testResult.value = null
  try {
    const result = await ipcRenderer.invoke('external-ipc:test-connection')
    testResult.value = {
      success: !!result?.success,
      error: result?.error,
      address: result?.address ?? ''
    }
    if (result?.success) {
      MessagePlugin.success(`IPC 通信正常 (${result.address})`)
    } else {
      MessagePlugin.error(`IPC 通信失败：${result?.error || '未知错误'}`)
    }
  } catch (error: any) {
    testResult.value = { success: false, error: String(error?.message || error), address: '' }
    MessagePlugin.error('测试 IPC 通信失败')
  } finally {
    testingConnection.value = false
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

async function copyIpcAddress() {
  try {
    await navigator.clipboard.writeText(ipcAddress.value)
    MessagePlugin.success('已复制 IPC 地址')
  } catch {
    MessagePlugin.error('复制失败')
  }
}
</script>

<style scoped></style>
