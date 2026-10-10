import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { authApi } from '../api/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    localStorage.removeItem('xorganam_token')
    localStorage.removeItem('xorganam_user')
    sessionStorage.removeItem('xorganam_token')
    sessionStorage.removeItem('xorganam_user')
    return null
  })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    authApi
      .me()
      .then((profile) => {
        if (!profile.isPlatformAdmin) {
          setUser(null)
          return
        }
        setUser(profile)
      })
      .catch(() => {
        setUser(null)
      })
      .finally(() => setReady(true))
  }, [])

  const login = useCallback(async (email, password) => {
    const result = await authApi.login(email, password)

    if (!result.user.isPlatformAdmin) {
      throw new Error(
        "This account is an Operator account. Please use the XORGANAM checkout app's Operator portal instead of the Backoffice dashboard."
      )
    }

    if (!result.mfaRequired) {
      setUser(result.user)
    }

    return result
  }, [])

  const completeMfa = useCallback(async (challengeToken, code) => {
    const result = await authApi.verifyMfa(challengeToken, code)
    setUser(result.user)
    return result.user
  }, [])

  const setupMfa = useCallback((challengeToken) => authApi.setupMfa(challengeToken), [])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // The browser state is still cleared so a stale token cannot remain usable.
    }
    localStorage.removeItem('xorganam_token')
    localStorage.removeItem('xorganam_user')
    sessionStorage.removeItem('xorganam_token')
    sessionStorage.removeItem('xorganam_user')
    setUser(null)
    window.location.href = '/login'
  }, [])

  return (
    <AuthContext.Provider value={{ user, ready, login, setupMfa, completeMfa, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
