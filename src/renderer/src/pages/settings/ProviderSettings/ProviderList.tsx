import type { DropResult } from '@hello-pangea/dnd'
import { loggerService } from '@logger'
import {
  DraggableVirtualList,
  type DraggableVirtualListRef,
  useDraggableReorder
} from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import { ProviderAvatar } from '@renderer/components/ProviderAvatar'
import { useAllProviders, useProviders } from '@renderer/hooks/useProvider'
import { useTimer } from '@renderer/hooks/useTimer'
import ImageStorage from '@renderer/services/ImageStorage'
import type { Provider, ProviderType } from '@renderer/types'
import { isSystemProvider } from '@renderer/types'
import { getFancyProviderName, matchKeywordsInModel, matchKeywordsInProvider, uuid } from '@renderer/utils'
import { download } from '@renderer/utils/download'
import type { MenuProps } from 'antd'
import { Button, Dropdown, Input, Tag } from 'antd'
import { Download, GripVertical, PlusIcon, Search, Upload, UserPen } from 'lucide-react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import useSWRImmutable from 'swr/immutable'

import AddProviderPopup from './AddProviderPopup'
import ModelNotesPopup from './ModelNotesPopup'
import ProviderSetting from './ProviderSetting'
import UrlSchemaInfoPopup from './UrlSchemaInfoPopup'

const logger = loggerService.withContext('ProviderList')

const BUTTON_WRAPPER_HEIGHT = 50
const PROVIDER_CONFIG_FILENAME = 'cherry-studio-providers.json'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseJson = <T,>(value: string, fallback: T, context: string): T => {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    logger.warn(`${context} JSON parse failed`, error as Error)
    return fallback
  }
}

const resolvePersistedLlm = (state: Record<string, unknown>): Record<string, unknown> => {
  const rawLlm = state.llm
  if (typeof rawLlm === 'string') {
    return parseJson<Record<string, unknown>>(rawLlm, {}, 'llm state')
  }
  if (isRecord(rawLlm)) {
    return rawLlm
  }
  return {}
}

const normalizeProviders = (value: unknown): Provider[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item) => isRecord(item) && typeof item.id === 'string') as Provider[]
}

const getIsOvmsSupported = async (): Promise<boolean> => {
  try {
    const result = await window.api.ovms.isSupported()
    return result
  } catch (e) {
    logger.warn('Fetching isOvmsSupported failed. Fallback to false.', e as Error)
    return false
  }
}

const ProviderList: FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const providers = useAllProviders()
  const { updateProviders, addProvider, removeProvider, updateProvider } = useProviders()
  const { setTimeoutTimer } = useTimer()
  const [selectedProvider, _setSelectedProvider] = useState<Provider>(providers[0])
  const { t } = useTranslation()
  const [searchText, setSearchText] = useState<string>('')
  const [dragging, setDragging] = useState(false)
  const [providerLogos, setProviderLogos] = useState<Record<string, string>>({})
  const listRef = useRef<DraggableVirtualListRef>(null)

  const { data: isOvmsSupported } = useSWRImmutable('ovms/isSupported', getIsOvmsSupported)

  const setSelectedProvider = useCallback((provider: Provider) => {
    startTransition(() => _setSelectedProvider(provider))
  }, [])

  useEffect(() => {
    const loadAllLogos = async () => {
      const logos: Record<string, string> = {}
      for (const provider of providers) {
        if (provider.id) {
          try {
            const logoData = await ImageStorage.get(`provider-${provider.id}`)
            if (logoData) {
              logos[provider.id] = logoData
            }
          } catch (error) {
            logger.error(`Failed to load logo for provider ${provider.id}`, error as Error)
          }
        }
      }
      setProviderLogos(logos)
    }

    loadAllLogos()
  }, [providers])

  useEffect(() => {
    if (searchParams.get('id')) {
      const providerId = searchParams.get('id')
      const provider = providers.find((p) => p.id === providerId)
      if (provider) {
        setSelectedProvider(provider)
        // 滚动到选中的 provider
        const index = providers.findIndex((p) => p.id === providerId)
        if (index >= 0) {
          setTimeoutTimer(
            'scroll-to-selected-provider',
            () => listRef.current?.scrollToIndex(index, { align: 'center' }),
            100
          )
        }
      } else {
        setSelectedProvider(providers[0])
      }
      searchParams.delete('id')
      setSearchParams(searchParams)
    }
  }, [providers, searchParams, setSearchParams, setSelectedProvider, setTimeoutTimer])

  // Handle provider add key from URL schema
  useEffect(() => {
    const handleProviderAddKey = async (data: {
      id: string
      apiKey: string
      baseUrl: string
      type?: ProviderType
      name?: string
    }) => {
      const { id } = data

      const { updatedProvider, isNew, displayName } = await UrlSchemaInfoPopup.show(data)
      window.navigate(`/settings/provider?id=${id}`)

      if (!updatedProvider) {
        return
      }

      if (isNew) {
        addProvider(updatedProvider)
      } else {
        updateProvider(updatedProvider)
      }

      setSelectedProvider(updatedProvider)
      window.toast.success(t('settings.models.provider_key_added', { provider: displayName }))
    }

    // 检查 URL 参数
    const addProviderData = searchParams.get('addProviderData')
    if (!addProviderData) {
      return
    }

    try {
      const { id, apiKey: newApiKey, baseUrl, type, name } = JSON.parse(addProviderData)
      if (!id || !newApiKey || !baseUrl) {
        window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
        window.navigate('/settings/provider')
        return
      }

      handleProviderAddKey({ id, apiKey: newApiKey, baseUrl, type, name })
    } catch (error) {
      window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
      window.navigate('/settings/provider')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const onAddProvider = async () => {
    const { name: providerName, type, logo } = await AddProviderPopup.show()

    if (!providerName.trim()) {
      return
    }

    const provider = {
      id: uuid(),
      name: providerName.trim(),
      type,
      apiKey: '',
      apiHost: '',
      models: [],
      enabled: true,
      isSystem: false
    } as Provider

    let updatedLogos = { ...providerLogos }
    if (logo) {
      try {
        await ImageStorage.set(`provider-${provider.id}`, logo)
        updatedLogos = {
          ...updatedLogos,
          [provider.id]: logo
        }
        setProviderLogos(updatedLogos)
      } catch (error) {
        logger.error('Failed to save logo', error as Error)
        window.toast.error(t('message.error.save_provider_logo'))
      }
    }

    addProvider(provider)
    setSelectedProvider(provider)
  }

  const getDropdownMenus = (provider: Provider): MenuProps['items'] => {
    const noteMenu = {
      label: t('settings.provider.notes.title'),
      key: 'notes',
      icon: <UserPen size={14} />,
      onClick: () => ModelNotesPopup.show({ provider })
    }

    const editMenu = {
      label: t('common.edit'),
      key: 'edit',
      icon: <EditIcon size={14} />,
      async onClick() {
        const { name, type, logoFile, logo } = await AddProviderPopup.show(provider)

        if (name) {
          updateProvider({ ...provider, name, type })
          if (provider.id) {
            if (logo) {
              try {
                await ImageStorage.set(`provider-${provider.id}`, logo)
                setProviderLogos((prev) => ({
                  ...prev,
                  [provider.id]: logo
                }))
              } catch (error) {
                logger.error('Failed to save logo', error as Error)
                window.toast.error(t('message.error.update_provider_logo'))
              }
            } else if (logo === undefined && logoFile === undefined) {
              try {
                await ImageStorage.set(`provider-${provider.id}`, '')
                setProviderLogos((prev) => {
                  const newLogos = { ...prev }
                  delete newLogos[provider.id]
                  return newLogos
                })
              } catch (error) {
                logger.error('Failed to reset logo', error as Error)
              }
            }
          }
        }
      }
    }

    const deleteMenu = {
      label: t('common.delete'),
      key: 'delete',
      icon: <DeleteIcon size={14} className="lucide-custom" />,
      danger: true,
      async onClick() {
        window.modal.confirm({
          title: t('settings.provider.delete.title'),
          content: t('settings.provider.delete.content'),
          okButtonProps: { danger: true },
          okText: t('common.delete'),
          centered: true,
          onOk: async () => {
            // 删除provider前先清理其logo
            if (provider.id) {
              try {
                await ImageStorage.remove(`provider-${provider.id}`)
                setProviderLogos((prev) => {
                  const newLogos = { ...prev }
                  delete newLogos[provider.id]
                  return newLogos
                })
              } catch (error) {
                logger.error('Failed to delete logo', error as Error)
              }
            }

            setSelectedProvider(providers.filter((p) => isSystemProvider(p))[0])
            removeProvider(provider)
          }
        })
      }
    }

    const menus = [editMenu, noteMenu, deleteMenu]

    if (providers.filter((p) => p.id === provider.id).length > 1) {
      return menus
    }

    if (isSystemProvider(provider)) {
      return [noteMenu]
    } else if (provider.isSystem) {
      // 这里是处理数据中存在新版本删掉的系统提供商的情况
      // 未来期望能重构一下，不要依赖isSystem字段
      return [noteMenu, deleteMenu]
    } else {
      return menus
    }
  }

  const filteredProviders = providers.filter((provider) => {
    // don't show it when isOvmsSupported is loading
    if (provider.id === 'ovms' && !isOvmsSupported) {
      return false
    }

    const keywords = searchText.toLowerCase().split(/\s+/).filter(Boolean)
    const isProviderMatch = matchKeywordsInProvider(keywords, provider)
    const isModelMatch = provider.models.some((model) => matchKeywordsInModel(keywords, model))
    return isProviderMatch || isModelMatch
  })

  const { onDragEnd: handleReorder, itemKey } = useDraggableReorder({
    originalList: providers,
    filteredList: filteredProviders,
    onUpdate: updateProviders,
    itemKey: 'id'
  })

  const handleDragStart = useCallback(() => {
    setDragging(true)
  }, [])

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      setDragging(false)
      handleReorder(result)
    },
    [handleReorder]
  )

  const handleExportProviders = useCallback(() => {
    try {
      const raw = localStorage.getItem('persist:cherry-studio')
      if (!raw) {
        logger.warn('persist:cherry-studio not found in localStorage')
        window.toast.error(t('settings.provider.import_export.export_failed'))
        return
      }

      const state = parseJson<Record<string, unknown>>(raw, {}, 'persist:cherry-studio')
      if (!isRecord(state)) {
        logger.warn('persist:cherry-studio is not a valid object')
        window.toast.error(t('settings.provider.import_export.export_failed'))
        return
      }

      const llm = resolvePersistedLlm(state)
      const payload = {
        exportedAt: new Date().toISOString(),
        providers: normalizeProviders(llm.providers),
        settings: isRecord(llm.settings) ? llm.settings : {}
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const blobUrl = URL.createObjectURL(blob)
      download(blobUrl, PROVIDER_CONFIG_FILENAME)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
      logger.info('Exported provider config', { count: payload.providers.length })
      window.toast.success(t('settings.provider.import_export.export_success'))
    } catch (error) {
      logger.error('Export provider config failed', error as Error)
      window.toast.error(t('settings.provider.import_export.export_failed'))
    }
  }, [t])

  const handleImportProviders = useCallback(() => {
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = '.json,application/json'

    fileInput.onchange = async () => {
      const file = fileInput.files?.[0]
      fileInput.remove()

      if (!file) {
        return
      }

      try {
        const text = await file.text()
        const imported = parseJson<Record<string, unknown>>(text, {}, 'imported provider config')
        if (!isRecord(imported)) {
          window.toast.error(t('settings.provider.import_export.import_invalid'))
          return
        }

        const importedProviders = normalizeProviders(imported.providers)
        const importedSettings = isRecord(imported.settings) ? imported.settings : {}

        const raw = localStorage.getItem('persist:cherry-studio')
        if (!raw) {
          logger.warn('persist:cherry-studio not found in localStorage')
          window.toast.error(t('settings.provider.import_export.import_failed'))
          return
        }

        const state = parseJson<Record<string, unknown>>(raw, {}, 'persist:cherry-studio')
        if (!isRecord(state)) {
          logger.warn('persist:cherry-studio is not a valid object')
          window.toast.error(t('settings.provider.import_export.import_failed'))
          return
        }

        const llm = resolvePersistedLlm(state)
        const currentProviders = normalizeProviders(llm.providers)
        const providerById = new Map<string, Provider>(currentProviders.map((provider) => [provider.id, provider]))
        importedProviders.forEach((provider) => providerById.set(provider.id, provider))

        const mergedProviders = Array.from(providerById.values())
        const mergedSettings = {
          ...(isRecord(llm.settings) ? llm.settings : {}),
          ...importedSettings
        }

        const nextLlm = {
          ...llm,
          providers: mergedProviders,
          settings: mergedSettings
        }

        const nextState = {
          ...state,
          llm: JSON.stringify(nextLlm)
        }

        localStorage.setItem('persist:cherry-studio', JSON.stringify(nextState))
        logger.info('Imported provider config', {
          totalProviders: mergedProviders.length,
          importedProviders: importedProviders.length
        })
        window.toast.success(t('settings.provider.import_export.import_success'))
        setTimeoutTimer('provider-import-reload', () => window.api.reload(), 800)
      } catch (error) {
        logger.error('Import provider config failed', error as Error)
        window.toast.error(t('settings.provider.import_export.import_failed'))
      }
    }

    fileInput.click()
  }, [setTimeoutTimer, t])

  return (
    <Container className="selectable">
      <ProviderListContainer>
        <AddButtonWrapper>
          <Input
            type="text"
            placeholder={t('settings.provider.search')}
            value={searchText}
            style={{ borderRadius: 'var(--list-item-border-radius)', height: 35 }}
            suffix={<Search size={14} />}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setSearchText('')
              }
            }}
            allowClear
            disabled={dragging}
          />
        </AddButtonWrapper>
        <AddButtonWrapper>
          <ImportExportRow>
            <Button
              style={{ flex: 1, borderRadius: 'var(--list-item-border-radius)' }}
              icon={<Upload size={16} />}
              onClick={handleImportProviders}
              disabled={dragging}>
              {t('settings.provider.import_export.import_button')}
            </Button>
            <Button
              style={{ flex: 1, borderRadius: 'var(--list-item-border-radius)' }}
              icon={<Download size={16} />}
              onClick={handleExportProviders}
              disabled={dragging}>
              {t('settings.provider.import_export.export_button')}
            </Button>
          </ImportExportRow>
        </AddButtonWrapper>
        <DraggableVirtualList
          ref={listRef}
          list={filteredProviders}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          estimateSize={useCallback(() => 40, [])}
          itemKey={itemKey}
          overscan={3}
          style={{
            height: `calc(100% - 3 * ${BUTTON_WRAPPER_HEIGHT}px)`
          }}
          scrollerStyle={{
            padding: 8,
            paddingRight: 5
          }}
          itemContainerStyle={{ paddingBottom: 5 }}>
          {(provider) => (
            <Dropdown menu={{ items: getDropdownMenus(provider) }} trigger={['contextMenu']}>
              <ProviderListItem
                key={provider.id}
                className={provider.id === selectedProvider?.id ? 'active' : ''}
                onClick={() => setSelectedProvider(provider)}>
                <DragHandle>
                  <GripVertical size={12} />
                </DragHandle>
                <ProviderAvatar
                  style={{
                    width: 24,
                    height: 24
                  }}
                  provider={provider}
                  customLogos={providerLogos}
                />
                <ProviderItemName className="text-nowrap">{getFancyProviderName(provider)}</ProviderItemName>
                {provider.enabled && (
                  <Tag color="green" style={{ marginLeft: 'auto', marginRight: 0, borderRadius: 16 }}>
                    ON
                  </Tag>
                )}
              </ProviderListItem>
            </Dropdown>
          )}
        </DraggableVirtualList>
        <AddButtonWrapper>
          <Button
            style={{ width: '100%', borderRadius: 'var(--list-item-border-radius)' }}
            icon={<PlusIcon size={16} />}
            onClick={onAddProvider}
            disabled={dragging}>
            {t('button.add')}
          </Button>
        </AddButtonWrapper>
      </ProviderListContainer>
      <ProviderSetting providerId={selectedProvider.id} key={selectedProvider.id} />
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
`

const ProviderListContainer = styled.div`
  display: flex;
  flex-direction: column;
  min-width: calc(var(--settings-width) + 10px);
  height: calc(100vh - var(--navbar-height));
  padding-bottom: 5px;
  border-right: 0.5px solid var(--color-border);
`

const ProviderListItem = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 5px 10px;
  width: 100%;
  border-radius: var(--list-item-border-radius);
  font-size: 14px;
  transition: all 0.2s ease-in-out;
  border: 0.5px solid transparent;
  user-select: none;
  cursor: pointer;
  &:hover {
    background: var(--color-background-soft);
  }
  &.active {
    background: var(--color-background-soft);
    border: 0.5px solid var(--color-border);
    font-weight: bold !important;
  }
`

const DragHandle = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -8px;
  width: 12px;
  color: var(--color-text-3);
  opacity: 0;
  transition: opacity 0.2s ease-in-out;
  cursor: grab;

  ${ProviderListItem}:hover & {
    opacity: 1;
  }

  &:active {
    cursor: grabbing;
  }
`

const ProviderItemName = styled.div`
  margin-left: 10px;
  font-weight: 500;
`

const AddButtonWrapper = styled.div`
  height: ${BUTTON_WRAPPER_HEIGHT}px;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 10px 8px;
`

const ImportExportRow = styled.div`
  display: flex;
  gap: 8px;
  width: 100%;
`

export default ProviderList
