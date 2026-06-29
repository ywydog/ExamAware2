import { EventEmitter } from 'events'
import type { ExamConfig, ExamInfo } from '@dsz-examaware/core'
import { parseDateTime } from '@dsz-examaware/core'
import { httpApiService } from '../http/httpApiService'
import { appLogger } from '../logging/winstonLogger'
import { getCurrentTimeMs } from '../ntpService/timeService'

export type ExamEventType =
  | 'exam-presentation-start'
  | 'exam-presentation-stop'
  | 'exam-start'
  | 'exam-time-remaining'
  | 'exam-end'

export interface ExamEventData {
  examName: string
  examConfigName: string
  startTime: string
  endTime: string
  remainingMinutes?: number
  alertTime?: number
}

export interface ExamEventMessage {
  type: 'exam-event'
  event: ExamEventType
  data: ExamEventData
  timestamp: number
}

export interface ExamStatusData {
  isPlaying: boolean
  currentExam: {
    name: string
    start: string
    end: string
    alertTime: number
    status: 'pending' | 'inProgress' | 'completed'
    remainingMs: number
  } | null
  examList: Array<{
    name: string
    start: string
    end: string
    status: 'pending' | 'inProgress' | 'completed'
  }>
  examConfigName: string
}

class ExamEventService extends EventEmitter {
  private currentConfig: ExamConfig | null = null
  private isPlaying = false
  private statusBroadcastInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  // Called when player window opens and starts presenting
  onPresentationStart(config: ExamConfig) {
    this.currentConfig = config
    this.isPlaying = true
    this.broadcastEvent('exam-presentation-start', {
      examName: config.examInfos?.[0]?.name ?? '',
      examConfigName: config.examName ?? '',
      startTime: config.examInfos?.[0]?.start ?? '',
      endTime: config.examInfos?.[0]?.end ?? ''
    })
    // Start periodic status broadcast
    this.startStatusBroadcast()
    // Register HTTP API routes (idempotent: 多次调用只会注册一次)
    this.registerApiRoutes()
  }

  onPresentationStop() {
    this.isPlaying = false
    const config = this.currentConfig
    this.currentConfig = null
    this.stopStatusBroadcast()
    if (config) {
      this.broadcastEvent('exam-presentation-stop', {
        examName: config.examInfos?.[0]?.name ?? '',
        examConfigName: config.examName ?? '',
        startTime: config.examInfos?.[0]?.start ?? '',
        endTime: config.examInfos?.[0]?.end ?? ''
      })
    }
  }

  // Called when an exam starts
  onExamStart(examInfo: ExamInfo) {
    this.broadcastEvent('exam-start', {
      examName: examInfo.name,
      examConfigName: this.currentConfig?.examName ?? '',
      startTime: examInfo.start,
      endTime: examInfo.end
    })
  }

  // Called when exam time is running out
  onExamAlert(examInfo: ExamInfo, alertTime: number) {
    const endTime = parseDateTime(examInfo.end).getTime()
    const now = getCurrentTimeMs()
    const remainingMinutes = Math.round((endTime - now) / 60000)
    this.broadcastEvent('exam-time-remaining', {
      examName: examInfo.name,
      examConfigName: this.currentConfig?.examName ?? '',
      startTime: examInfo.start,
      endTime: examInfo.end,
      remainingMinutes,
      alertTime
    })
  }

  // Called when an exam ends
  onExamEnd(examInfo: ExamInfo) {
    this.broadcastEvent('exam-end', {
      examName: examInfo.name,
      examConfigName: this.currentConfig?.examName ?? '',
      startTime: examInfo.start,
      endTime: examInfo.end
    })
  }

  private broadcastEvent(event: ExamEventType, data: ExamEventData) {
    const message: ExamEventMessage = {
      type: 'exam-event',
      event,
      data,
      timestamp: getCurrentTimeMs()
    }
    appLogger.info(`[exam-event] Broadcasting: ${event} - ${data.examName}`)
    this.emit('exam-event', message)
    // The WebSocket server will listen to this event and forward to clients
  }

  getExamStatus(): ExamStatusData {
    const now = getCurrentTimeMs()
    const config = this.currentConfig

    if (!config || !this.isPlaying) {
      return {
        isPlaying: false,
        currentExam: null,
        examList: [],
        examConfigName: ''
      }
    }

    // Find current exam
    let currentExam: ExamStatusData['currentExam'] = null
    const examList: ExamStatusData['examList'] = []

    for (const exam of config.examInfos) {
      const startTime = parseDateTime(exam.start).getTime()
      const endTime = parseDateTime(exam.end).getTime()

      let status: 'pending' | 'inProgress' | 'completed' = 'pending'
      if (now >= endTime) status = 'completed'
      else if (now >= startTime) status = 'inProgress'

      examList.push({
        name: exam.name,
        start: exam.start,
        end: exam.end,
        status
      })

      if (status === 'inProgress') {
        currentExam = {
          name: exam.name,
          start: exam.start,
          end: exam.end,
          alertTime: exam.alertTime,
          status,
          remainingMs: endTime - now
        }
      }
    }

    return {
      isPlaying: this.isPlaying,
      currentExam,
      examList,
      examConfigName: config.examName
    }
  }

  private startStatusBroadcast() {
    this.stopStatusBroadcast()
    // Broadcast status every 30 seconds
    this.statusBroadcastInterval = setInterval(() => {
      this.emit('exam-status', this.getExamStatus())
    }, 30000)
  }

  private stopStatusBroadcast() {
    if (this.statusBroadcastInterval) {
      clearInterval(this.statusBroadcastInterval)
      this.statusBroadcastInterval = null
    }
  }

  private routesRegistered = false
  /**
   * 注册考试相关 HTTP API 路由。
   * 使用 addPersistentRoute 保证 HTTP 服务重启后路由不丢失。
   */
  private registerApiRoutes() {
    if (this.routesRegistered) return
    this.routesRegistered = true
    const buildRoutes = () => [
      {
        method: 'get' as const,
        path: '/exam/status',
        namespace: 'exam',
        summary: '获取当前考试状态',
        tags: ['exam'],
        handler: async () => this.getExamStatus()
      },
      {
        method: 'get' as const,
        path: '/exam/current',
        namespace: 'exam',
        summary: '获取当前进行中的考试',
        tags: ['exam'],
        handler: async () => {
          const status = this.getExamStatus()
          return status.currentExam
        }
      },
      {
        method: 'get' as const,
        path: '/exam/list',
        namespace: 'exam',
        summary: '获取考试列表',
        tags: ['exam'],
        handler: async () => {
          const status = this.getExamStatus()
          return { examConfigName: status.examConfigName, exams: status.examList }
        }
      }
    ]
    for (const r of buildRoutes()) {
      httpApiService.addPersistentRoute(() => r)
    }
  }

  async dispose() {
    this.stopStatusBroadcast()
    this.removeAllListeners()
    this.currentConfig = null
    this.isPlaying = false
    this.routesRegistered = false
  }
}

export const examEventService = new ExamEventService()
