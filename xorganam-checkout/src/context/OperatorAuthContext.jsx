import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { operatorAuth } from '../api/client'

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
    operatorAuth.saveSession(result)
    setUser(result.user)
    return result.user
  }, [])

  const register = useCallback(async (payload) => {
    const result = await operatorAuth.register(payload)
    operatorAuth.saveSession(result)
    setUser(result.user)
    return result.user
  }, [])

  const logout = useCallback(() => {
    operatorAuth.clearSession()
    setUser(null)
  }, [])

  const hasMinRole = useCallback(
    (minimumRole) => !!user && (ROLE_RANK[user.role] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0),
    [user]
  )

  return (
    <OperatorAuthContext.Provider value={{ user, ready, login, register, logout, hasMinRole }}>
      {children}
    </OperatorAuthContext.Provider>
  )
}

export function useOperatorAuth() {
  const ctx = useContext(OperatorAuthContext)
  if (!ctx) throw new Error('useOperatorAuth must be used within OperatorAuthProvider')
  return ctx
}
