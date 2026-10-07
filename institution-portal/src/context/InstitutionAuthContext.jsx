import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { institutionAuth } from '../api/client.js'

const InstitutionAuthContext = createContext(null)

export function InstitutionAuthProvider({ children }) {
  const [staff, setStaff] = useState(() => institutionAuth.getStoredStaff())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!institutionAuth.hasToken()) {
      setReady(true)
      return
    }
    institutionAuth
      .me()
      .then((profile) => {
        setStaff(profile.staff)
        sessionStorage.setItem('xorganam_institution_staff', JSON.stringify(profile.staff))
      })
      .catch(() => {
        institutionAuth.clearSession()
        setStaff(null)
      })
      .finally(() => setReady(true))
  }, [])

  const login = useCallback(async (email, password) => {
    const result = await institutionAuth.login(email, password)
    if (!result.mfaRequired && result.token) {
      institutionAuth.saveSession(result)
      setStaff(result.staff)
    }
    return result
  }, [])

  const completeMfa = useCallback(async (challengeToken, code) => {
    const result = await institutionAuth.verifyMfa(challengeToken, code)
    institutionAuth.saveSession(result)
    setStaff(result.staff)
    return result.staff
  }, [])

  const setupMfa = useCallback((challengeToken) => institutionAuth.setupMfa(challengeToken), [])

  const logout = useCallback(() => {
    institutionAuth.clearSession()
    setStaff(null)
  }, [])

  const value = { staff, ready, login, setupMfa, completeMfa, logout }
  return <InstitutionAuthContext.Provider value={value}>{children}</InstitutionAuthContext.Provider>
}

export function useInstitutionAuth() {
  const value = useContext(InstitutionAuthContext)
  if (!value) throw new Error('useInstitutionAuth must be used within InstitutionAuthProvider')
  return value
}
