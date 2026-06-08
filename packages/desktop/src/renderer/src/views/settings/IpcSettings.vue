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
              ExamAware2 窗口间通信（播放器 → 主进程 → WebSocket 事件推送），始终启用，无需配置。
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
              允许外部程序（如 ClassIsland 插件）通过 Named Pipe / Unix Socket 控制 ExamAware2 的放映功能。
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

const externalIpcEnabled = ref(settingsApi.get('externalIpc.enabled', false))

const ipcAddress = computed(() => {
  if (typeof navigator === 'undefined') return ''
  return navigator.platform?.startsWith('Win')
    ? '\\\\.\\pipe\\ExamAware2.examaware2'
    : '/tmp/ExamAware2.examaware2.sock'
})

const commands = ['ping', 'play-from-url', 'play-from-file', 'stop', 'status']

watch(externalIpcEnabled, (val) => {
  settingsApi.set('externalIpc.enabled', val)
})

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
