import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { operatorAuth } from '../api/client'
import { hasPermission as checkPermission } from '../constants/permissions'

const OperatorAuthContext = createContext(null)

// Mirrors the backend's ROLE_RANK (src/middleware/auth.js) - used only to
// decide what the UI offers; the real enforcement is server-side.
const ROLE_RANK = {
  TENANT_ADMIN: 40,
  TENANT_MANAGER: 30,
  TENANT_OPERATOR: 20,
  TENANT_VIEWER: 10
}

export function OperatorAuthProvider({ children }) {
  const [user, setUser] = useState(() => operatorAuth.getStoredUser())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!operatorAuth.hasToken()) {
      setReady(true)
      return
    }
    operatorAuth
      .me()
      .then((profile) => setUser(profile))
      .catch(() => {
        operatorAuth.clearSession()
        setUser(null)
      })
      .finally(() => setReady(true))
  }, [])

  const login = useCallback(async (email, password) => {
    const result = await operatorAuth.login(email, password)
    if (result.user.isPlatformAdmin) {
      throw new Error('This is a platform admin account. Please use the Backoffice dashboard instead.')
    }
    if (!result.mfaRequired && result.token) {
      operatorAuth.saveSession(result)
      setUser(result.user)
      operatorAuth.me().then(setUser).catch(() => {})
    }
    return result
  }, [])

  const completeMfa = useCallback(async (challengeToken, verification) => {
    const result = await operatorAuth.verifyMfa(challengeToken, verification)
    operatorAuth.saveSession(result)
    setUser(result.user)
    operatorAuth.me().then(setUser).catch(() => {})
    return result
  }, [])

  const setupMfa = useCallback((challengeToken) => operatorAuth.setupMfa(challengeToken), [])

  const register = useCallback(async (payload) => {
    return operatorAuth.register(payload)
  }, [])

  const requestEmailVerification = useCallback(
    (email) => operatorAuth.requestEmailVerification(email),
    []
  )

  const logout = useCallback(async () => {
    try {
      if (operatorAuth.hasToken()) await operatorAuth.logout()
    } catch {
      // Clear local access even if remote revocation is unavailable.
    } finally {
      operatorAuth.clearSession()
      setUser(null)
    }
  }, [])

  const hasMinRole = useCallback(
    (minimumRole) => !!user && (ROLE_RANK[user.role] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0),
    [user]
  )

  const hasPermission = useCallback(
    (permissionType, resourceId = null) => !!user && checkPermission(user.role, user.permissions || [], permissionType, resourceId),
    [user]
  )

  return (
    <OperatorAuthContext.Provider value={{ user, ready, login, setupMfa, completeMfa, register, requestEmailVerification, logout, hasMinRole, hasPermission }}>
      {children}
    </OperatorAuthContext.Provider>
  )
}

export function useOperatorAuth() {
  const ctx = useContext(OperatorAuthContext)
  if (!ctx) throw new Error('useOperatorAuth must be used within OperatorAuthProvider')
  return ctx
}
